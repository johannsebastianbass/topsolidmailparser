// Cria um contato fixo para cada canal de formulário (no-reply@topsolid.com,
// mkt.sales@topsolid.com, marketing@cadsolid.pt). É o passo que permite
// DESLIGAR a criação automática de lead na caixa marketing@: o formulário passa
// a cair no contato do canal e a integração cria o lead (ver README).
//
//   node tools/contatos-canal.mjs              -> simulação: mostra o que faria
//   node tools/contatos-canal.mjs --aplicar    -> cria os contatos que faltam
//
// Opção: --health <url> (padrão: <portal>/mailparser/health)
//
// TRAVA: só cria se o servidor em produção anunciar o recurso
// 'formulario-em-contato'. A versão antiga não conferia o tipo do dono da
// atividade: um formulário caindo num contato faria ela atualizar um LEAD
// qualquer com o mesmo número de ID.
//
// Não exclui nem altera nada que já exista.

import config from '../src/config.js';
import { chamar } from '../src/bitrix.js';

const args = process.argv.slice(2);
const aplicar = args.includes('--aplicar');
const i = args.indexOf('--health');
const urlHealth = i !== -1 && args[i + 1] ? args[i + 1] : `${config.bitrix.dominio}/mailparser/health`;

const RESPONSAVEL = config.lead.assignedById;

// 1. Qual versão está em produção?
let health;
try {
    const r = await fetch(urlHealth);
    health = await r.json();
} catch (e) {
    console.log(`não foi possível ler ${urlHealth}: ${(e.cause && e.cause.code) || e.message}`);
    process.exit(1);
}
const pronto = (health.recursos || []).includes('formulario-em-contato');
console.log(`\nservidor: commit ${health.commit || '(desconhecido)'}, no ar há ${Math.round(health.uptime / 3600)} h`);
if (!pronto) {
    console.log('\nPARADO: o servidor ainda roda a versão antiga (não anuncia \'formulario-em-contato\').');
    console.log('Instale antes:  cd /opt/topsolid-mailparser && git pull && npm ci --omit=dev && sudo systemctl restart topsolid-mailparser\n');
    process.exit(1);
}
console.log('versão nova em produção: OK\n');

// 2. Cada canal já tem contato? Algum lead segura o endereço do canal?
const criar = [];
for (const canal of config.remetentesPermitidos) {
    const contatos = (await chamar('crm.contact.list', { FILTER: { EMAIL: canal }, SELECT: ['ID', 'NAME'] })).result || [];
    const leads = (await chamar('crm.lead.list', { FILTER: { EMAIL: canal }, SELECT: ['ID', 'TITLE', 'STATUS_ID'] })).result || [];

    if (contatos.length) console.log(`  ${canal.padEnd(26)} já tem contato: ${contatos.map((c) => c.ID).join(', ')}`);
    else { console.log(`  ${canal.padEnd(26)} sem contato -> ${aplicar ? 'criando' : 'seria criado'}`); criar.push(canal); }

    // Um lead com o endereço do canal disputa com o contato: o Bitrix pode
    // anexar os formulários seguintes a ele.
    for (const l of leads) console.log(`  !  o lead ${l.ID} (${l.STATUS_ID}) "${l.TITLE}" tem o endereço ${canal} — tirar o e-mail dele`);
}

if (!aplicar) {
    console.log(`\nSimulação. ${criar.length} contato(s) a criar. Rode com --aplicar para criar.\n`);
    process.exit(0);
}

for (const canal of criar) {
    const r = await chamar('crm.contact.add', {
        fields: {
            NAME: `Canal de formulário ${canal}`,
            EMAIL: [{ VALUE: canal, VALUE_TYPE: 'WORK' }],
            ASSIGNED_BY_ID: RESPONSAVEL,
            COMMENTS: 'Contato técnico do Mail Parser: recebe os e-mails de formulário deste canal, '
                + 'e a integração cria o lead a partir deles. Não excluir, não mesclar, não converter.',
        },
    });
    console.log(`  contato ${r.result} criado para ${canal}`);
}
console.log(`\nPróximo passo: desligar a criação automática de lead na caixa ${config.caixasMonitoradas.join(', ')}.\n`);
