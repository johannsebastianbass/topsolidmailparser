// Fluxo principal: recebe o ID de uma atividade do Bitrix, identifica o
// formulário que originou o e-mail e atualiza o lead correspondente.

import config from './config.js';
import { buscarAtividade, excluirLead } from './bitrix.js';
import { acharLayout } from './layouts.js';
import { extrairCampos } from './htmlParser.js';
import { atualizarLeadComFormulario } from './lead.js';
import { log, erro, separador } from './logger.js';

const TIPO_ENTIDADE_LEAD = 1;

// O Bitrix registra e-mail com PROVIDER_ID 'CRM_EMAIL' e o tipo varia entre
// 'EMAIL' e 'EMAIL_COMPRESSED'. A versão anterior aceitava só 'EMAIL' — no
// portal crm.topsolidbrazil.com TODAS as atividades de e-mail são
// 'EMAIL_COMPRESSED', então a integração descartaria 100% delas. O corpo do
// e-mail vem completo nos dois casos.
const TIPOS_DE_EMAIL = ['EMAIL', 'EMAIL_COMPRESSED'];

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

    // Filtro opcional por remetente. Os formulários chegam encaminhados sempre
    // das mesmas caixas; com a lista preenchida, newsletter, cobrança e e-mail
    // de fornecedor nem são tocados — nada de excluir lead por engano.
    // Vazio (padrão) = aceita qualquer remetente.
    if (!remetenteAceito(remetente)) {
        log(`ATENÇÃO: remetente '${remetente}' fora da lista permitida (${config.remetentesPermitidos.join(', ')}); ignorado. Se este for um formulário legítimo, acrescente o endereço em REMETENTES_PERMITIDOS.`);
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
        await descartarLead(atividade, assunto);
        return;
    }

    log('layout identificado', layout.id);
    const brutos = extrairCampos(atividade.DESCRIPTION || '', layout.campos, layout.fim);

    await atualizarLeadComFormulario(leadId, assunto, layout, brutos);
}

/**
 * Assunto desconhecido: o lead criado automaticamente pelo Bitrix não serve.
 */
async function descartarLead(atividade, assunto) {
    const leadId = atividade.OWNER_ID;
    const tipo = Number(atividade.OWNER_TYPE_ID);

    // Sem essa checagem, uma atividade ligada a um negócio ou contato faria a
    // exclusão de um LEAD com o mesmo número de ID — outro registro qualquer.
    if (!leadId || tipo !== TIPO_ENTIDADE_LEAD) {
        log(`assunto não reconhecido ('${assunto}') e atividade não pertence a um lead; nada excluído`);
        return;
    }

    if (!config.excluirLeadDesconhecido) {
        log(`assunto não reconhecido ('${assunto}'); lead ${leadId} SERIA excluído (exclusão desligada)`);
        return;
    }

    log(`assunto não reconhecido ('${assunto}'); excluindo lead ${leadId}`);
    await excluirLead(leadId);
}
