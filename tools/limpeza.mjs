// Limpeza do passivo de contatos repetidos nos cartões de lead.
//
//   node tools/limpeza.mjs repetidos              -> simulação (NÃO altera nada)
//   node tools/limpeza.mjs repetidos --aplicar    -> executa e grava backup
//   node tools/limpeza.mjs revisao                -> CSV do que exige decisão humana
//   node tools/limpeza.mjs reverter <backup.json> --aplicar  -> desfaz a limpeza
//
// Opções: --paginas N (padrão 40, ou seja 2000 leads) | --backup <arquivo>
//
// O QUE ESTA FERRAMENTA REMOVE (seguro, sem perda de informação):
//   - o MESMO telefone repetido em formatos diferentes no mesmo cartão
//     ((51)99377-7962 e 51993777962 são o mesmo número)
//   - o MESMO e-mail repetido com diferença de maiúsculas/espaços
//
// O QUE ELA NÃO FAZ (exige decisão de quem conhece o negócio):
//   - cartão com e-mails de PESSOAS DIFERENTES: apagar perderia contato real.
//     São leads de feira em que a planilha juntou o estande inteiro num registro;
//     o certo é separar em leads/contatos, não descartar endereço.
//   - leads duplicados (mesmo e-mail em vários cartões): apagar destrói
//     histórico; o Bitrix tem mesclagem própria para isso.
//   Os dois casos saem no comando `revisao`, em CSV, para conferência.

import fs from 'fs';
import { chamar } from '../src/bitrix.js';

const args = process.argv.slice(2);
const comando = args[0];
const aplicar = args.includes('--aplicar');

function opcao(nome, padrao) {
    const i = args.indexOf(nome);
    if (i === -1) return padrao;
    const valor = args[i + 1];
    return valor && !valor.startsWith('--') ? valor : padrao;
}

const paginas = Number(opcao('--paginas', 40)) || 40;
const arquivoBackup = opcao('--backup', `limpeza-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

/** Dois telefones são o mesmo número se os dígitos coincidirem, ignorando o DDI. */
function chaveTelefone(valor) {
    let d = String(valor || '').replace(/\D/g, '');
    if (d.length > 11 && d.indexOf('55') === 0) d = d.slice(2);
    return d;
}

const chaveEmail = (valor) => String(valor || '').trim().toLowerCase();

async function lerLeads() {
    const leads = [];
    let start = 0;

    for (let p = 0; p < paginas; p++) {
        const data = await chamar('crm.lead.list', {
            SELECT: ['ID', 'TITLE', 'NAME', 'LAST_NAME', 'COMPANY_TITLE', 'EMAIL', 'PHONE', 'DATE_CREATE', 'SOURCE_ID', 'SOURCE_DESCRIPTION'],
            ORDER: { ID: 'desc' },
            start,
        });

        const lote = (data && data.result) || [];
        leads.push(...lote);
        process.stdout.write(`\r lidos ${leads.length} leads...`);

        if (data.next === undefined || !lote.length) break;
        start = data.next;
    }

    process.stdout.write('\r                              \r');
    return leads;
}

/**
 * Encontra valores repetidos num campo múltiplo.
 * Mantém sempre a primeira ocorrência (menor ID = mais antiga).
 */
function acharRepetidos(itens, chaveDe) {
    const vistos = new Map();
    const remover = [];

    for (const item of itens || []) {
        if (!item || !item.ID) continue;
        const chave = chaveDe(item.VALUE);
        if (!chave) continue;

        if (vistos.has(chave)) remover.push({ item, mantido: vistos.get(chave) });
        else vistos.set(chave, item);
    }

    return remover;
}

async function comandoRepetidos() {
    const leads = await lerLeads();

    const plano = [];
    for (const lead of leads) {
        const emails = acharRepetidos(lead.EMAIL, chaveEmail);
        const fones = acharRepetidos(lead.PHONE, chaveTelefone);
        if (emails.length || fones.length) plano.push({ lead, emails, fones });
    }

    const totalValores = plano.reduce((n, p) => n + p.emails.length + p.fones.length, 0);
    console.log(`\n${leads.length} leads lidos`);
    console.log(`${plano.length} cartões com valor repetido, ${totalValores} valores a remover\n`);

    for (const { lead, emails, fones } of plano.slice(0, 25)) {
        console.log(`lead ${lead.ID}  ${String(lead.TITLE).slice(0, 50)}`);
        for (const r of emails) console.log(`   remove EMAIL ${r.item.ID} "${r.item.VALUE}"  (igual a "${r.mantido.VALUE}")`);
        for (const r of fones) console.log(`   remove PHONE ${r.item.ID} "${r.item.VALUE}"  (igual a "${r.mantido.VALUE}")`);
    }
    if (plano.length > 25) console.log(`... e mais ${plano.length - 25} cartões`);

    if (!plano.length) return;

    if (!aplicar) {
        console.log('\nSIMULACAO - nada foi alterado. Para executar de verdade: --aplicar');
        return;
    }

    // Backup do estado atual antes de qualquer escrita.
    const backup = plano.map(({ lead }) => ({
        ID: lead.ID,
        TITLE: lead.TITLE,
        EMAIL: lead.EMAIL || [],
        PHONE: lead.PHONE || [],
    }));
    fs.writeFileSync(arquivoBackup, JSON.stringify(backup, null, 2), 'utf8');
    console.log(`\nbackup do estado anterior: ${arquivoBackup}`);

    let alterados = 0;
    let falhas = 0;

    for (const { lead, emails, fones } of plano) {
        // Remoção de campo múltiplo exige ID + TYPE_ID + VALUE vazio.
        const fields = {};
        if (emails.length) fields.EMAIL = emails.map((r) => ({ ID: r.item.ID, TYPE_ID: r.item.TYPE_ID || 'EMAIL', VALUE: '' }));
        if (fones.length) fields.PHONE = fones.map((r) => ({ ID: r.item.ID, TYPE_ID: r.item.TYPE_ID || 'PHONE', VALUE: '' }));

        try {
            await chamar('crm.lead.update', { ID: lead.ID, FIELDS: fields });
            alterados++;
            process.stdout.write(`\r aplicados ${alterados}/${plano.length}...`);
        } catch (e) {
            falhas++;
            console.log(`\n   lead ${lead.ID} falhou: ${(e && e.message) || e}`);
        }
    }

    console.log(`\n\n${alterados} cartões atualizados, ${falhas} falhas.`);
    console.log(`Para desfazer: node tools/limpeza.mjs reverter ${arquivoBackup} --aplicar`);
}

async function comandoRevisao() {
    const leads = await lerLeads();
    const linhas = ['tipo;leadId;titulo;origem;criado;detalhe'];

    // 1) cartões com contatos de pessoas diferentes
    for (const lead of leads) {
        const distintos = [...new Set((lead.EMAIL || []).map((e) => chaveEmail(e.VALUE)).filter(Boolean))];
        if (distintos.length > 1) {
            linhas.push(`multiplos-emails;${lead.ID};"${lead.TITLE}";${lead.SOURCE_ID || ''};${lead.DATE_CREATE};"${distintos.join(' | ')}"`);
        }
    }

    // 2) mesmo e-mail em vários cartões
    const porEmail = new Map();
    for (const lead of leads) {
        for (const e of new Set((lead.EMAIL || []).map((x) => chaveEmail(x.VALUE)).filter(Boolean))) {
            if (!porEmail.has(e)) porEmail.set(e, []);
            porEmail.get(e).push(lead);
        }
    }
    for (const [email, lista] of porEmail) {
        if (lista.length < 2) continue;
        linhas.push(`leads-duplicados;;"${email}";;;"${lista.map((l) => l.ID).join(' ')}"`);
    }

    const arquivo = `revisao-${new Date().toISOString().slice(0, 10)}.csv`;
    fs.writeFileSync(arquivo, '﻿' + linhas.join('\n'), 'utf8');

    const multi = linhas.filter((l) => l.startsWith('multiplos-emails')).length;
    const dup = linhas.filter((l) => l.startsWith('leads-duplicados')).length;

    console.log(`\n${leads.length} leads lidos`);
    console.log(`${multi} cartões com e-mails de pessoas diferentes`);
    console.log(`${dup} endereços presentes em mais de um cartão`);
    console.log(`\nCSV para revisão: ${arquivo}`);
}

/**
 * Desfaz uma limpeza regravando os valores do backup que não estão mais no
 * cartão. Os IDs originais não voltam: os valores são recriados.
 */
async function comandoReverter() {
    const arquivo = args[1];
    if (!arquivo || !fs.existsSync(arquivo)) {
        console.log('informe o arquivo: node tools/limpeza.mjs reverter limpeza-backup-....json --aplicar');
        process.exit(1);
    }

    const backup = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    console.log(`${backup.length} cartões no backup`);

    if (!aplicar) {
        for (const b of backup.slice(0, 10)) {
            console.log(`lead ${b.ID}: ${(b.EMAIL || []).length} e-mail(s) e ${(b.PHONE || []).length} telefone(s) no estado original`);
        }
        console.log('\nSIMULACAO - nada foi alterado. Para executar de verdade: --aplicar');
        return;
    }

    let restaurados = 0;
    for (const b of backup) {
        const atual = (await chamar('crm.lead.get', { ID: b.ID })).result || {};
        const fields = {};

        for (const campo of ['EMAIL', 'PHONE']) {
            const presentes = new Set((atual[campo] || []).map((i) => String(i.VALUE || '')));
            const faltando = (b[campo] || []).filter((i) => !presentes.has(String(i.VALUE || '')));
            if (faltando.length) {
                fields[campo] = faltando.map((i) => ({ TYPE_ID: i.TYPE_ID || campo, VALUE_TYPE: i.VALUE_TYPE || 'WORK', VALUE: i.VALUE }));
            }
        }

        if (!Object.keys(fields).length) continue;
        await chamar('crm.lead.update', { ID: b.ID, FIELDS: fields });
        restaurados++;
        process.stdout.write(`\r restaurados ${restaurados}...`);
    }

    console.log(`\n${restaurados} cartões restaurados.`);
}

const acoes = { repetidos: comandoRepetidos, revisao: comandoRevisao, reverter: comandoReverter };

if (!acoes[comando]) {
    console.log('uso: node tools/limpeza.mjs <repetidos|revisao|reverter <arquivo>> [--aplicar] [--paginas N]');
    process.exit(1);
}

acoes[comando]().catch((e) => {
    console.error('falhou:', (e && e.message) || e);
    process.exit(1);
});
