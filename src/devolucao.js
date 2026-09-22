// Leitura das notificações automáticas de e-mail (devolução, supressão,
// reclamação) e registro dos endereços que falharam.
//
// Usado em dois lugares, com a mesma regra:
//  - src/topSolid.js grava cada devolução em CSV assim que ela chega. É a lista
//    que o marketing usa para limpar a base de envio, e não depende de ninguém
//    ir atrás do cartão no CRM;
//  - tools/devolucoes.mjs extrai o histórico que já está no CRM.

import fs from 'fs';

const REGEX_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

// Endereços que aparecem no corpo da notificação mas nunca são o destinatário
// que falhou: o próprio sistema de e-mail e os domínios da empresa.
const NAO_E_DESTINATARIO = /amazonses\.com|email-abuse|mailer-daemon|postmaster|@topsolidbrazil\.com$|@topsolid\.com$|@cadsolid\.pt$/i;

export function limparTexto(html) {
    return String(html || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&#(\d+);/g, (m, d) => String.fromCharCode(Number(d)))
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ');
}

export function motivoDe(texto) {
    if (/suppression list/i.test(texto)) return 'na lista de supressão da SES';
    if (/complaint/i.test(texto)) return 'reclamação de spam';
    const m = texto.match(/\b[45]\d\d[ -]?(\d\.\d\.\d+)?[^.]{0,90}/);
    return m ? m[0].trim().slice(0, 90) : 'devolução';
}

/**
 * 5xx = permanente: o endereço não serve mais, tirar da lista.
 * 4xx = temporária: caixa cheia, servidor ocupado; manter.
 */
export function tipoDe(motivo) {
    if (/supress|reclama/i.test(motivo)) return 'permanente';
    const m = String(motivo).match(/(?:^|\D)([45])\d\d(?:\D|$)/);
    if (m) return m[1] === '4' ? 'temporaria' : 'permanente';
    return 'permanente';
}

export function destinatariosDe(texto) {
    return [...new Set((texto.match(REGEX_EMAIL) || []).map((e) => e.toLowerCase()))]
        .filter((e) => !NAO_E_DESTINATARIO.test(e));
}

export function campanhaDe(assunto) {
    return String(assunto || '').replace(/^(Não é possível entregar|Undeliverable):\s*/i, '');
}

/**
 * Lê uma atividade de notificação e devolve os registros encontrados.
 */
export function lerNotificacao(atividade) {
    const texto = limparTexto(atividade.DESCRIPTION);
    const motivo = motivoDe(texto);
    const tipo = tipoDe(motivo);
    const campanha = campanhaDe(atividade.SUBJECT);
    return destinatariosDe(texto).map((email) => ({ email, tipo, motivo, campanha, data: atividade.CREATED || '' }));
}

const CABECALHO = 'email;tipo;motivo;data;campanha;atividade\n';
const campo = (v) => String(v || '').replace(/[;\r\n]/g, ',');

/**
 * Acrescenta os registros ao CSV (cria com cabeçalho na primeira vez).
 * Síncrono de propósito: o registro tem que estar em disco antes de qualquer
 * outra coisa acontecer com o cartão.
 */
export function gravarDevolucoes(arquivo, registros, idAtividade) {
    if (!arquivo || !registros.length) return;
    if (!fs.existsSync(arquivo)) fs.writeFileSync(arquivo, '﻿' + CABECALHO, 'utf8');
    const linhas = registros.map((r) =>
        [r.email, r.tipo, r.motivo, r.data, r.campanha, idAtividade].map(campo).join(';')).join('\n') + '\n';
    fs.appendFileSync(arquivo, linhas, 'utf8');
}
