// Cliente do webhook REST do Bitrix24.
//
// Dois cuidados que faltavam na versão anterior:
//  1. O Bitrix responde HTTP 200 mesmo quando a chamada falha — o erro vem em
//     `data.error`. Sem checar isso, a integração falhava em silêncio.
//  2. Toda requisição tem timeout. Sem timeout, uma chamada pendurada segura o
//     processo indefinidamente.

import axios from 'axios';
import https from 'https';
import config from './config.js';
import { erro } from './logger.js';

const agent = new https.Agent({ rejectUnauthorized: true });

// O Bitrix limita cerca de 2 requisições por segundo por portal. Cada e-mail
// processado faz 5 chamadas; com vários e-mails chegando juntos, parte delas
// voltava com erro de limite — e, como o erro vinha em HTTP 200, ninguém via.
// Aqui as chamadas são enfileiradas e espaçadas.
const intervaloConfigurado = Number(process.env.BITRIX_INTERVALO_MS);
const INTERVALO_MIN_MS = Number.isFinite(intervaloConfigurado) ? intervaloConfigurado : 550;
const MAX_TENTATIVAS = 3;
const BACKOFF_BASE_MS = 1000;
const ERROS_TEMPORARIOS = /QUERY_LIMIT_EXCEEDED|OPERATION_TIME_LIMIT|OVERLOAD|ETIMEDOUT|ECONNRESET|ECONNABORTED|socket hang up|50[0-9]|429/i;

const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let fila = Promise.resolve();
let ultimaChamada = 0;

/** Executa `fn` respeitando o intervalo mínimo entre chamadas ao portal. */
function enfileirar(fn) {
    const resultado = fila.then(async () => {
        const faltando = INTERVALO_MIN_MS - (Date.now() - ultimaChamada);
        if (faltando > 0) await espera(faltando);
        ultimaChamada = Date.now();
        return fn();
    });
    fila = resultado.then(() => {}, () => {});   // a fila não pode quebrar num erro
    return resultado;
}

function ehTemporario(e) {
    const texto = [e && e.message, e && e.code, e && e.response && e.response.status].join(' ');
    return ERROS_TEMPORARIOS.test(texto);
}

// Métodos que CRIAM registro. Repetir um deles depois de um erro de REDE pode
// duplicar: o Bitrix pode ter criado o lead e a resposta é que se perdeu no
// caminho (timeout, conexão cortada). Erro de negócio (QUERY_LIMIT_EXCEEDED e
// afins) chega como resposta completa, prova de que nada foi criado, e por isso
// continua sendo repetido normalmente.
const METODOS_QUE_CRIAM = /\.add$/i;

/** Vale a pena (e é seguro) repetir esta chamada depois deste erro? */
export function podeRepetir(metodo, e) {
    if (!ehTemporario(e)) return false;
    const semResposta = Boolean(e && e.ehDeRede);
    return !(semResposta && METODOS_QUE_CRIAM.test(metodo));
}

/**
 * Chama um método do Bitrix. Lança em erro de rede ou erro de negócio.
 */
export async function chamar(metodo, params = {}) {
    if (!config.bitrix.webhook) {
        throw new Error('BITRIX_WEBHOOK não definido (configure no ambiente ou no arquivo .env)');
    }

    let ultimoErro;
    for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
        try {
            return await enfileirar(() => requisitar(metodo, params));
        } catch (e) {
            ultimoErro = e;
            if (ehTemporario(e) && !podeRepetir(metodo, e)) {
                erro(`${metodo} falhou sem resposta do portal; NÃO será repetido para não duplicar registro`, e);
                throw e;
            }
            if (!podeRepetir(metodo, e) || tentativa === MAX_TENTATIVAS) throw e;
            const pausa = BACKOFF_BASE_MS * Math.pow(2, tentativa);
            erro(`${metodo} falhou por limite/instabilidade; tentativa ${tentativa + 1} em ${pausa}ms`, e);
            await espera(pausa);
        }
    }
    throw ultimoErro;
}

async function requisitar(metodo, params) {
    let resposta;
    try {
        resposta = await axios.post(`${config.bitrix.webhook}/${metodo}`, params, {
            httpsAgent: agent,
            timeout: config.bitrix.timeoutMs,
            headers: { 'Content-Type': 'application/json' },
        });
    } catch (e) {
        // Sem resposta do portal: não dá para saber se a operação foi executada.
        if (!e || !e.response) e = Object.assign(e || new Error('falha de rede'), { ehDeRede: true });
        throw e;
    }

    const data = resposta.data;
    if (data && data.error) {
        throw new Error(`${metodo}: ${data.error} - ${data.error_description || 'sem descrição'}`);
    }
    return data;
}

/**
 * Igual a `chamar`, mas nunca lança: registra o erro e devolve null.
 * Use para efeitos colaterais que não devem derrubar o fluxo principal
 * (post no mural, por exemplo).
 */
export async function tentar(metodo, params = {}) {
    try {
        return await chamar(metodo, params);
    } catch (e) {
        erro(`chamada ao Bitrix '${metodo}'`, e);
        return null;
    }
}

export async function buscarAtividade(id) {
    const data = await chamar('crm.activity.get', { ID: id });
    return data && data.result;
}

export async function buscarLead(id) {
    const data = await chamar('crm.lead.get', { ID: id });
    return data && data.result;
}

export function atualizarLead(id, fields) {
    return chamar('crm.lead.update', { ID: id, FIELDS: fields });
}

// Não existe função de exclusão de lead de propósito: neste Bitrix, apagar o
// lead faz a sincronização da caixa reimportar o e-mail e recriar o lead.

export async function criarLead(fields) {
    const data = await chamar('crm.lead.add', { fields });
    return data && data.result;
}

/**
 * Vincula uma atividade (o e-mail) a mais um lead, sem tirá-la de onde está.
 * Não lança: falhar aqui não pode impedir o lead de existir.
 */
export function vincularAtividade(atividadeId, leadId) {
    return tentar('crm.activity.binding.add', { activityId: atividadeId, entityTypeId: 1, entityId: leadId });
}

/**
 * Lista leads. `filter` é objeto — a versão anterior montava o JSON à mão com
 * template string, o que quebrava se o e-mail tivesse aspas.
 */
export async function listarLeads(filter, select = ['ID', 'TITLE'], order = { ID: 'desc' }) {
    const data = await chamar('crm.lead.list', { FILTER: filter, SELECT: select, ORDER: order });
    return {
        itens: (data && data.result) || [],
        total: (data && data.total) || 0,
    };
}

/**
 * Publica um comentário na linha do tempo do lead. Não lança.
 *
 * Usa crm.timeline.comment.add. O método antigo, crm.livefeedmessage.add,
 * continua aparecendo na lista de métodos deste Bitrix mas responde "Livefeed
 * is no longer supported" — e como a publicação não derruba o fluxo, os
 * resumos "Informações Brutas" falharam em silêncio desde a instalação.
 */
export function postarNoMural(leadId, mensagem) {
    return tentar('crm.timeline.comment.add', {
        fields: { ENTITY_ID: leadId, ENTITY_TYPE: 'lead', COMMENT: mensagem },
    });
}
