// Fluxo principal: recebe o ID de uma atividade do Bitrix, identifica o
// formulário que originou o e-mail e atualiza o lead correspondente.

import config from './config.js';
import { buscarAtividade, buscarLead, excluirLead } from './bitrix.js';
import { acharLayout } from './layouts.js';
import { extrairCampos } from './htmlParser.js';
import {
    atualizarLeadComFormulario,
    acharSubmissaoAnterior,
    registrarSubmissaoRepetida,
    normalizarDados,
    comTrava,
} from './lead.js';
import { log, erro, separador } from './logger.js';

const TIPO_ENTIDADE_LEAD = 1;

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

    // Devolução, supressão, reclamação: o lead que o Bitrix criou para o
    // remetente automático é lixo. Só é apagado se o PRÓPRIO lead tiver como
    // e-mail um endereço automático — uma devolução anexada a um cliente real
    // nunca apaga o cliente.
    if (ehRemetenteAutomatico(remetente)) {
        await excluirLeadCriadoPeloEmail(atividade, 'notificação automática de e-mail (devolução/supressão/reclamação)', {
            exigir: ehLeadDeRemetenteAutomatico,
            descricaoExigencia: 'o lead não é de um endereço automático',
        });
        return;
    }

    // Filtro por remetente: decide o que é FORMULÁRIO a ser lido. Quem está fora
    // da lista pode ser gente de verdade escrevendo para o marketing (em 22/09:
    // Ferkoda S/A, Laurenti Moveis, Sidnei Pires) — esses leads ficam intactos.
    if (!remetenteAceito(remetente)) {
        log(`remetente '${remetente}' não é origem de formulário; lead mantido como está. Se for um formulário legítimo, acrescente o endereço em REMETENTES_PERMITIDOS.`);
        return;
    }

    const assunto = String(atividade.SUBJECT || '');
    const leadId = atividade.OWNER_ID;
    log('assunto', assunto);

    if (ehRespostaDeEmail(assunto)) {
        log('resposta de e-mail; lead mantido sem alteração');
        return;
    }

    const layout = acharLayout(assunto);
    if (!layout) {
        await excluirLeadCriadoPeloEmail(atividade, `assunto não reconhecido ('${assunto}')`);
        return;
    }

    log('layout identificado', layout.id);
    const brutos = extrairCampos(atividade.DESCRIPTION || '', layout.campos, layout.fim);
    const email = normalizarDados(brutos).email;

    // Serializa pelo e-mail do cliente: se a mesma submissão chegar duas vezes
    // ao mesmo tempo, a segunda só roda depois que a primeira gravou o lead, e
    // assim consegue enxergá-la como anterior.
    await comTrava(email ? `email:${email.toLowerCase()}` : `lead:${leadId}`, async () => {
        const anterior = await acharSubmissaoAnterior(leadId, email, assunto);
        if (anterior) {
            log(`mesma submissão já registrada no lead ${anterior.ID}`);
            const excluido = await excluirLeadCriadoPeloEmail(atividade, `submissão repetida do lead ${anterior.ID}`);
            if (excluido) {
                await registrarSubmissaoRepetida(anterior.ID, layout, assunto, brutos);
                return;
            }
            // Não deu para excluir (exclusão desligada ou lead já trabalhado):
            // preenche normalmente, como antes — o aviso de duplicidade aparece
            // nos dois cards. Nunca deixar um lead cru para trás.
        }

        await atualizarLeadComFormulario(leadId, assunto, layout, brutos);
    });
}

/**
 * Único caminho de exclusão da integração. Um lead só é apagado se TODAS as
 * condições forem verdadeiras:
 *
 *  1. a atividade pertence a um lead (não a contato ou negócio);
 *  2. o lead ainda está como o Bitrix o criou a partir do e-mail
 *     (SOURCE_ID = 'EMAIL') — lead que alguém já trabalhou, ou que a própria
 *     integração preencheu (WEBFORM), nunca é apagado;
 *  3. a exigência específica do caso, quando houver;
 *  4. a exclusão está ligada (BITRIX_EXCLUIR_LEAD_DESCONHECIDO=true).
 *
 * Com a exclusão desligada, registra no log o que SERIA apagado.
 * Devolve true somente quando o lead foi de fato excluído.
 */
async function excluirLeadCriadoPeloEmail(atividade, motivo, { exigir, descricaoExigencia } = {}) {
    const leadId = atividade.OWNER_ID;

    // Sem essa checagem, uma atividade ligada a um negócio ou contato faria a
    // exclusão de um LEAD com o mesmo número de ID — outro registro qualquer.
    if (!leadId || Number(atividade.OWNER_TYPE_ID) !== TIPO_ENTIDADE_LEAD) {
        log(`${motivo}; atividade não pertence a um lead, nada excluído`);
        return false;
    }

    let lead;
    try {
        lead = await buscarLead(leadId);
    } catch (e) {
        erro(`leitura do lead ${leadId} antes de excluir`, e);
        return false;
    }
    if (!lead) {
        log(`${motivo}; lead ${leadId} já não existe`);
        return false;
    }

    if (lead.SOURCE_ID !== 'EMAIL') {
        log(`${motivo}; lead ${leadId} mantido — origem '${lead.SOURCE_ID}', já foi trabalhado ou preenchido`);
        return false;
    }

    if (exigir && !exigir(lead)) {
        log(`${motivo}; lead ${leadId} mantido — ${descricaoExigencia || 'não confere com o esperado'}`);
        return false;
    }

    if (!config.excluirLeadDesconhecido) {
        log(`${motivo}; lead ${leadId} SERIA excluído (exclusão desligada)`);
        return false;
    }

    log(`${motivo}; excluindo lead ${leadId}`);
    await excluirLead(leadId);
    return true;
}
