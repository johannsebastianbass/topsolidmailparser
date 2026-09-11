// Diagnóstico dos dois sintomas relatados. SOMENTE LEITURA — não altera nada
// no CRM.
//
//   node tools/diagnostico.mjs lead 12345      -> e-mails/telefones de um lead
//   node tools/diagnostico.mjs acumulados      -> leads com mais de um e-mail
//   node tools/diagnostico.mjs duplicados      -> e-mails presentes em vários leads
//
// Use BITRIX_WEBHOOK no ambiente para não depender do token embutido.

import { chamar } from '../src/bitrix.js';

// O espaçamento entre chamadas é feito pelo cliente em src/bitrix.js.

async function listarTodosOsLeads(limitePaginas = 40) {
    const leads = [];
    let start = 0;

    for (let pagina = 0; pagina < limitePaginas; pagina++) {
        const data = await chamar('crm.lead.list', {
            SELECT: ['ID', 'TITLE', 'EMAIL', 'DATE_CREATE', 'SOURCE_ID', 'STATUS_ID'],
            ORDER: { ID: 'desc' },
            start,
        });

        const lote = (data && data.result) || [];
        leads.push(...lote);
        process.stdout.write(`\r lidos ${leads.length} leads...`);

        if (data.next === undefined || !lote.length) break;
        start = data.next;
    }

    process.stdout.write('\r');
    return leads;
}

const emailsDo = (lead) => ((lead && lead.EMAIL) || []).map((e) => String(e.VALUE || '').toLowerCase()).filter(Boolean);

async function verLead(id) {
    const data = await chamar('crm.lead.get', { ID: id });
    const lead = data && data.result;
    if (!lead) return console.log(`lead ${id} não encontrado`);

    console.log(`\nLead ${lead.ID} — ${lead.TITLE}`);
    console.log(`criado em ${lead.DATE_CREATE}\n`);

    for (const campo of ['EMAIL', 'PHONE']) {
        const itens = lead[campo] || [];
        console.log(`${campo} (${itens.length}):`);
        if (!itens.length) console.log('   (vazio)');
        for (const item of itens) {
            console.log(`   ID=${item.ID}  TYPE_ID=${item.TYPE_ID}  VALUE_TYPE=${item.VALUE_TYPE}  VALUE=${item.VALUE}`);
        }
        if (itens.length > 1) {
            console.log(`   >> ${itens.length} valores: o antigo não foi removido na atualização.`);
        }
        console.log('');
    }
}

async function verAcumulados() {
    const leads = await listarTodosOsLeads();
    const comVarios = leads.filter((l) => emailsDo(l).length > 1);

    console.log(`\n${leads.length} leads lidos, ${comVarios.length} com mais de um e-mail no cartão\n`);
    for (const lead of comVarios.slice(0, 50)) {
        console.log(`lead ${String(lead.ID).padEnd(8)} ${lead.DATE_CREATE}  ${emailsDo(lead).join('  |  ')}`);
    }
    if (comVarios.length > 50) console.log(`... e mais ${comVarios.length - 50}`);
}

async function verDuplicados() {
    const leads = await listarTodosOsLeads();

    const porEmail = new Map();
    for (const lead of leads) {
        for (const email of emailsDo(lead)) {
            if (!porEmail.has(email)) porEmail.set(email, []);
            porEmail.get(email).push(lead);
        }
    }

    const repetidos = [...porEmail.entries()]
        .filter(([, lista]) => lista.length > 1)
        .sort((a, b) => b[1].length - a[1].length);

    const semEmail = leads.filter((l) => !emailsDo(l).length).length;

    console.log(`\n${leads.length} leads lidos`);
    console.log(`${repetidos.length} e-mails aparecem em mais de um lead`);
    console.log(`${semEmail} leads sem nenhum e-mail (o Bitrix não consegue vincular a próxima mensagem a eles)\n`);

    for (const [email, lista] of repetidos.slice(0, 40)) {
        console.log(`${String(lista.length).padStart(3)}x  ${email}`);
        console.log(`      leads: ${lista.map((l) => l.ID).join(', ')}`);
    }
    if (repetidos.length > 40) console.log(`... e mais ${repetidos.length - 40}`);
}

const [comando, arg] = process.argv.slice(2);

const acoes = {
    lead: () => verLead(arg),
    acumulados: verAcumulados,
    duplicados: verDuplicados,
};

if (!acoes[comando] || (comando === 'lead' && !arg)) {
    console.log('uso: node tools/diagnostico.mjs <lead <ID> | acumulados | duplicados>');
    process.exit(1);
}

acoes[comando]().catch((e) => {
    console.error('falhou:', (e && e.message) || e);
    process.exit(1);
});
