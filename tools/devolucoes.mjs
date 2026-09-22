// Lista os endereços que devolveram (bounce) ou foram suprimidos pela SES,
// a partir das notificações que chegam na caixa monitorada. SOMENTE LEITURA.
//
//   node tools/devolucoes.mjs                  -> desde 7 dias atrás
//   node tools/devolucoes.mjs 2026-09-01       -> desde a data
//
// Gera devolucoes-<data>.csv para o marketing tirar esses endereços da lista.
// Endereço que devolve com "mailbox unavailable" não existe mais: continuar
// mandando para ele derruba a reputação da conta na SES e pode pausar o envio.

import fs from 'fs';
import { chamar } from '../src/bitrix.js';
import { lerNotificacao, tipoDe } from '../src/devolucao.js';

const desde = process.argv[2] || new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);

// Remetentes das notificações automáticas (devolução e reclamação).
const REMETENTE_AUTOMATICO = /mailer-daemon|postmaster|email-abuse|amazonses\.com/i;

async function lerNotificacoes() {
    const itens = [];
    let start = 0;
    for (let p = 0; p < 200; p++) {
        const r = await chamar('crm.activity.list', {
            FILTER: { PROVIDER_ID: 'CRM_EMAIL', '>CREATED': `${desde}T00:00:00` },
            SELECT: ['ID', 'CREATED', 'SUBJECT', 'SETTINGS'],
            ORDER: { ID: 'asc' },
            start,
        });
        for (const a of r.result || []) {
            const de = String(((a.SETTINGS || {}).EMAIL_META || {}).from || '');
            if (REMETENTE_AUTOMATICO.test(de)) itens.push(a);
        }
        process.stdout.write(`\r notificações encontradas: ${itens.length}...`);
        if (r.next === undefined) break;
        start = r.next;
    }
    process.stdout.write('\r                                       \r');
    return itens;
}

const notificacoes = await lerNotificacoes();
const porEndereco = new Map();

for (const n of notificacoes) {
    // A lista não traz DESCRIPTION; o corpo precisa de get individual.
    const a = (await chamar('crm.activity.get', { ID: n.ID })).result || {};
    for (const r of lerNotificacao(a)) {
        const e = r.email;
        const motivo = r.motivo;
        const atual = porEndereco.get(e) || { vezes: 0, motivo, ultima: n.CREATED, assunto: a.SUBJECT };
        atual.vezes++;
        atual.ultima = n.CREATED;
        porEndereco.set(e, atual);
    }
    process.stdout.write(`\r lidas ${notificacoes.indexOf(n) + 1}/${notificacoes.length}...`);
}
process.stdout.write('\r                                       \r');

const linhas = ['email;tipo;vezes;motivo;ultima_notificacao;campanha'];
const ordenados = [...porEndereco.entries()].sort((a, b) => b[1].vezes - a[1].vezes);
for (const [email, d] of ordenados) {
    const campanha = String(d.assunto || '').replace(/^(Não é possível entregar|Undeliverable):\s*/i, '').replace(/;/g, ',');
    linhas.push(`${email};${tipoDe(d.motivo)};${d.vezes};${d.motivo.replace(/;/g, ',')};${d.ultima};${campanha}`);
}

const arquivo = `devolucoes-${new Date().toISOString().slice(0, 10)}.csv`;
fs.writeFileSync(arquivo, '﻿' + linhas.join('\n'), 'utf8');

console.log(`\n${notificacoes.length} notificações automáticas desde ${desde}`);
const permanentes = ordenados.filter(([, d]) => tipoDe(d.motivo) === 'permanente').length;
console.log(`${porEndereco.size} endereços distintos`);
console.log(`   ${permanentes} permanentes  -> TIRAR da lista de envio`);
console.log(`   ${porEndereco.size - permanentes} temporários -> manter (caixa cheia, servidor ocupado)`);
console.log(`\nprimeiros:`);
for (const [email, d] of ordenados.slice(0, 12)) console.log(`   ${tipoDe(d.motivo).padEnd(11)} ${email.padEnd(38)} ${d.motivo.slice(0, 50)}`);
console.log(`\nCSV: ${arquivo}`);
