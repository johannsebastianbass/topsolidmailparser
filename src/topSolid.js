// Fluxo principal: recebe o ID de uma atividade do Bitrix, identifica o
// formulário que originou o e-mail e atualiza o lead correspondente.
//
// REGRAS (definidas com o cliente em 22/09/2026):
//  - e-mail de FORMULÁRIO vindo dos canais configurados vira lead, preservando
//    o DE/PARA;
//  - e-mail de QUALQUER OUTRO canal não é tocado: fica na caixa para o
//    marketing avaliar e converter à mão ("o que não pode é excluir ou
//    converter todos os e-mails que chegam");
//  - lead criado À MÃO nunca é sobrescrito;
//  - a integração NUNCA exclui lead. Neste Bitrix, apagar o lead apaga o
//    vínculo do e-mail, e a sincronização da caixa reimporta a mensagem e cria
//    outro lead ~45 min depois (visto em 22/09: lead 31598 apagado, recriado
//    como 31609). Excluir vira um laço.

import config from './config.js';
import { buscarAtividade } from './bitrix.js';
import { acharLayout } from './layouts.js';
import { extrairCampos } from './htmlParser.js';
import {
    atualizarLeadComFormulario,
    criarLeadDoFormulario,
    acharSubmissaoAnterior,
    registrarSubmissaoRepetida,
    marcarComoDuplicata,
    normalizarDados,
    comTrava,
} from './lead.js';
import { lerNotificacao, gravarDevolucoes } from './devolucao.js';
import { log, erro, separador } from './logger.js';

const TIPO_ENTIDADE_LEAD = 1;
const TIPO_ENTIDADE_CONTATO = 3;

// O Bitrix registra e-mail com PROVIDER_ID 'CRM_EMAIL' e o tipo varia entre
// 'EMAIL' e 'EMAIL_COMPRESSED'. A versão anterior aceitava só 'EMAIL' — no
// portal crm.topsolidbrazil.com TODAS as atividades de e-mail são
// 'EMAIL_COMPRESSED', então a integração descartaria 100% delas. O corpo do
// e-mail vem completo nos dois casos.
const TIPOS_DE_EMAIL = ['EMAIL', 'EMAIL_COMPRESSED'];

// Notificações automáticas de sistemas de e-mail: devolução (bounce), aviso de
// supressão e reclamação de spam. Uma campanha de marketing para uma lista ruim
// gera centenas delas de uma vez (255 em 22/09), e cada uma vira atividade na
// caixa monitorada — o Bitrix cria um lead para o remetente
// "mailer-daemon@...amazonses.com" e vai empilhando as devoluções nele.
const REMETENTE_AUTOMATICO = /mailer-daemon|postmaster|email-abuse|@[\w.-]*amazonses\.com/i;

export function ehRemetenteAutomatico(remetente) {
    return REMETENTE_AUTOMATICO.test(String(remetente || ''));
}

const REGEX_ENDERECO = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/**
 * O lead foi criado para um remetente automático?
 *
 * Normalmente o endereço está no EMAIL do lead. Mas nos leads de reclamação da
 * SES o Bitrix deixa o EMAIL VAZIO e põe o endereço no nome e no título (visto
 * em 22/09: leads 31593, 31595, 31596, 31599). Nesse caso usa o endereço que
 * estiver no nome/título — mas só se for de fato um endereço de e-mail. Um lead
 * de pessoa real com e-mail vazio tem um nome ("João Silva"), não um endereço,
 * e por isso nunca casa aqui.
 */
export function ehLeadDeRemetenteAutomatico(lead) {
    if (!lead) return false;
    let enderecos = (lead.EMAIL || []).map((e) => String(e.VALUE || '')).filter(Boolean);
    if (!enderecos.length) {
        enderecos = `${lead.NAME || ''} ${lead.TITLE || ''}`.match(REGEX_ENDERECO) || [];
    }
    return enderecos.length > 0 && enderecos.every(ehRemetenteAutomatico);
}

export function remetenteAceito(remetente) {
    const permitidos = config.remetentesPermitidos;
    if (!permitidos.length) return true;
    const alvo = remetente.toLowerCase();
    return permitidos.some((p) => alvo.indexOf(p.toLowerCase()) !== -1);
}

function ehAtividadeDeEmail(atividade) {
    return atividade.PROVIDER_ID === 'CRM_EMAIL'
        || TIPOS_DE_EMAIL.indexOf(atividade.PROVIDER_TYPE_ID) !== -1;
}

// O Bitrix pode entregar o mesmo webhook mais de uma vez (reenvio, ou eventos
// ON_CRM_ACTIVITY_ADD e ON_CRM_ACTIVITY_UPDATE apontando para o mesmo handler).
// Sem esta trava, cada entrega repetia todo o processamento: outro e-mail no
// cartão, outro post no mural, outro alerta de duplicidade.
const JANELA_DEDUPE_MS = 5 * 60 * 1000;
const atividadesProcessadas = new Map();

function jaProcessada(idActivity) {
    const agora = Date.now();
    for (const [chave, quando] of atividadesProcessadas) {
        if (agora - quando > JANELA_DEDUPE_MS) atividadesProcessadas.delete(chave);
    }
    if (atividadesProcessadas.has(idActivity)) return true;
    atividadesProcessadas.set(idActivity, agora);
    return false;
}

/**
 * Libera a atividade da trava. Chamado quando o processamento falha, para que
 * uma reentrega do webhook possa tentar de novo — senão uma falha temporária
 * (limite do Bitrix, rede) descartaria o lead de vez.
 */
function liberarDedupe(idActivity) {
    atividadesProcessadas.delete(idActivity);
}

// RESPOSTA não é conversão: reprocessar sobrescreveria o lead com o texto
// citado. ENCAMINHAMENTO é: os formulários do site chegam encaminhados de
// outra caixa e trazem o corpo original. Confirmado na base migrada — 52 leads
// vieram de assuntos "FW:" ("FW: Website CadSolid - Download Trial TopSolid 7")
// e nenhum de "RE:". Por isso 'fw'/'fwd'/'enc' NÃO entram nesta expressão.
const ASSUNTO_DE_RESPOSTA = /(^|\s)(re|res)\s*:/i;

export function ehRespostaDeEmail(assunto) {
    return ASSUNTO_DE_RESPOSTA.test(String(assunto || ''));
}

/**
 * Ponto de entrada. Nunca lança: qualquer falha é registrada no log, porque o
 * webhook já respondeu ao Bitrix e uma promise rejeitada aqui derrubaria o
 * processo (unhandled rejection).
 */
export default async function topSolid(idActivity) {
    try {
        await processarAtividade(idActivity);
    } catch (e) {
        liberarDedupe(idActivity);
        erro(`processamento da atividade ${idActivity}`, e);
    } finally {
        separador();
    }
}

async function processarAtividade(idActivity) {
    if (!idActivity) {
        log('atividade sem ID; ignorada');
        return;
    }

    if (jaProcessada(idActivity)) {
        log(`atividade ${idActivity} já processada há pouco; entrega repetida ignorada`);
        return;
    }

    const atividade = await buscarAtividade(idActivity);
    if (!atividade) {
        log(`atividade ${idActivity} não encontrada`);
        return;
    }

    if (!ehAtividadeDeEmail(atividade)) {
        log(`atividade ${idActivity} não é e-mail (${atividade.PROVIDER_ID}/${atividade.PROVIDER_TYPE_ID}); ignorada`);
        return;
    }

    // SETTINGS/EMAIL_META podem não existir. Antes o acesso era direto e o
    // TypeError virava unhandled rejection.
    const meta = (atividade.SETTINGS && atividade.SETTINGS.EMAIL_META) || {};
    const destinatario = String(meta.__email || '');
    const remetente = String(meta.from || '');

    log('e-mail recebido em', destinatario);
    log('e-mail enviado por', remetente);

    const caixa = destinatario.toLowerCase();
    if (config.caixasMonitoradas.indexOf(caixa) === -1) {
        log(`destinatário '${destinatario}' fora das caixas monitoradas (${config.caixasMonitoradas.join(', ')}); ignorado`);
        return;
    }

    // E-mail que a própria caixa enviou (a atividade registra o envio, não uma
    // conversão do site).
    if (remetente.toLowerCase().indexOf(caixa) !== -1) {
        log('e-mail enviado pela própria caixa monitorada; ignorado');
        return;
    }

    // Devolução, supressão, reclamação: só registra o endereço que falhou, para
    // o marketing limpar a lista. Não mexe em lead nenhum.
    if (ehRemetenteAutomatico(remetente)) {
        const registros = lerNotificacao(atividade);
        gravarDevolucoes(config.arquivoDevolucoes, registros, atividade.ID);
        for (const r of registros) log(`DEVOLUÇÃO ${r.tipo}: ${r.email} — ${r.motivo}`);
        return;
    }

    // Outro canal: gente escrevendo para o marketing (flyer de feira, QR code),
    // fornecedor, newsletter. Não é formulário — o marketing avalia e converte.
    if (!remetenteAceito(remetente)) {
        log(`e-mail de outro canal ('${remetente}'); nada alterado — fica para o marketing avaliar`);
        return;
    }

    const assunto = String(atividade.SUBJECT || '');
    log('assunto', assunto);

    if (ehRespostaDeEmail(assunto)) {
        log('resposta de e-mail; nada alterado');
        return;
    }

    const layout = acharLayout(assunto);
    if (!layout) {
        log(`canal de formulário, mas o assunto não é de um formulário conhecido ('${assunto}'); nada alterado`);
        return;
    }

    const tipoDono = Number(atividade.OWNER_TYPE_ID);
    if (tipoDono !== TIPO_ENTIDADE_LEAD && tipoDono !== TIPO_ENTIDADE_CONTATO) {
        log(`formulário anexado a entidade tipo ${tipoDono}; nada alterado`);
        return;
    }

    log('layout identificado', layout.id);
    const brutos = extrairCampos(atividade.DESCRIPTION || '', layout.campos, layout.fim);
    const email = normalizarDados(brutos).email;
    const deParaDoEmail = { de: remetente, para: destinatario };
    const leadDono = tipoDono === TIPO_ENTIDADE_LEAD ? atividade.OWNER_ID : null;

    // Serializa pelo e-mail do cliente: se a mesma submissão chegar duas vezes
    // ao mesmo tempo, a segunda só roda depois que a primeira gravou o lead, e
    // assim consegue enxergá-la como anterior.
    await comTrava(email ? `email:${email.toLowerCase()}` : `atividade:${atividade.ID}`, async () => {
        const anterior = await acharSubmissaoAnterior(leadDono, email, assunto);

        if (tipoDono === TIPO_ENTIDADE_LEAD) {
            // O Bitrix criou um lead para o e-mail (criação automática ligada na
            // caixa). Preenche esse lead — ou, se for a mesma submissão repetida,
            // marca como duplicata SEM apagar.
            if (anterior) {
                log(`mesma submissão já registrada no lead ${anterior.ID}; lead ${leadDono} marcado como duplicata`);
                await registrarSubmissaoRepetida(anterior.ID, layout, assunto, brutos, deParaDoEmail);
                await marcarComoDuplicata(leadDono, anterior.ID);
                return;
            }
            await atualizarLeadComFormulario(leadDono, assunto, layout, brutos, atividade, deParaDoEmail);
            return;
        }

        // O e-mail caiu num CONTATO de canal (a caixa não cria lead sozinha e o
        // remetente do formulário é um contato conhecido). A integração cria o
        // lead e vincula o e-mail a ele.
        if (anterior) {
            log(`mesma submissão já registrada no lead ${anterior.ID}; nenhum lead novo criado`);
            await registrarSubmissaoRepetida(anterior.ID, layout, assunto, brutos, deParaDoEmail);
            return;
        }
        await criarLeadDoFormulario(atividade, assunto, layout, brutos, deParaDoEmail);
    });
}
