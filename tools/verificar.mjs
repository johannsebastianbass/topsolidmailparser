// Verificação do webhook e do portal. SOMENTE LEITURA — não cria, não altera e
// não exclui nada.
//
//   node tools/verificar.mjs
//
// Confere: conectividade, escopos concedidos, usuário dono do webhook, campos
// customizados usados no payload e os IDs das listas.

import config from '../src/config.js';
import { chamar } from '../src/bitrix.js';
import {
    MAPA_FIELD_OF_ACTIVITY,
    MAPA_INDUSTRY_INTEREST,
    MAPA_FIELD_OF_APPLICATION,
    MAPA_PAIS,
} from '../src/layouts.js';

const ok = (t) => console.log(`  OK    ${t}`);
const falha = (t) => console.log(`  FALHA ${t}`);
const alerta = (t) => console.log(`  !     ${t}`);

async function tentar(metodo, params) {
    try {
        return { data: await chamar(metodo, params) };
    } catch (e) {
        return { erro: (e && e.message) || String(e) };
    }
}

console.log(`\nwebhook: ${config.bitrix.webhook.replace(/\/[^/]+$/, '/***')}`);
console.log(`domínio: ${config.bitrix.dominio}\n`);

// ---------- conectividade e escopos ----------
console.log('Conexão e escopos');
const escopo = await tentar('scope');
if (escopo.erro) {
    falha(`não foi possível chamar o portal: ${escopo.erro}`);
    process.exit(1);
}
const escopos = escopo.data.result || [];
ok(`portal respondeu; escopos concedidos: ${escopos.join(', ') || '(nenhum)'}`);
if (!escopos.includes('crm')) falha("escopo 'crm' NÃO concedido — a integração não funciona sem ele");
if (!escopos.includes('log')) alerta("escopo 'log' não concedido — se o post no mural falhar, é isto");

// ---------- usuário dono do webhook ----------
console.log('\nUsuário do webhook (é com os direitos dele que tudo roda)');
const perfil = await tentar('profile');
if (perfil.erro) {
    falha(perfil.erro);
} else {
    const p = perfil.data.result || {};
    ok(`ID ${p.ID} — ${p.NAME || ''} ${p.LAST_NAME || ''} (${p.EMAIL || 'sem e-mail'})`);
    if (p.ADMIN === true) ok('é administrador do portal: tem todos os direitos de CRM');
    else alerta('NÃO é administrador: confirme leitura, alteração e exclusão de leads de TODA a empresa');
}

// ---------- responsável configurado ----------
console.log(`\nResponsável atribuído aos leads (ASSIGNED_BY_ID = ${config.lead.assignedById})`);
const resp = await tentar('user.get', { ID: config.lead.assignedById });
if (resp.erro) {
    alerta(`não foi possível verificar (${resp.erro}) — exige escopo 'user'`);
} else {
    const u = (resp.data.result || [])[0];
    if (!u) falha(`usuário ${config.lead.assignedById} NÃO existe neste portal — todo lead vai falhar ou ficar sem responsável`);
    else if (u.ACTIVE === false) falha(`usuário ${u.ID} (${u.NAME} ${u.LAST_NAME}) está INATIVO`);
    else ok(`usuário ${u.ID} — ${u.NAME || ''} ${u.LAST_NAME || ''}`);
}

// ---------- campos customizados ----------
console.log('\nCampos customizados usados no payload do lead');
const campos = await tentar('crm.lead.fields');
if (campos.erro) {
    falha(campos.erro);
    process.exit(1);
}
const disponiveis = campos.data.result || {};

const listas = {};
for (const [nome, codigo] of Object.entries(config.campos)) {
    const campo = disponiveis[codigo];
    if (!campo) {
        falha(`${nome.padEnd(20)} ${codigo}  NÃO EXISTE neste portal`);
        continue;
    }
    ok(`${nome.padEnd(20)} ${codigo}  (${campo.type}) ${campo.formLabel || campo.title || ''}`);
    if (campo.items) listas[codigo] = campo.items;
}

// ---------- IDs das listas ----------
console.log('\nIDs de lista gravados no código');
const mapas = [
    ['fieldOfActivity', MAPA_FIELD_OF_ACTIVITY],
    ['industryInterest', MAPA_INDUSTRY_INTEREST],
    ['fieldOfApplication', MAPA_FIELD_OF_APPLICATION],
];

for (const [nome, mapa] of mapas) {
    const codigo = config.campos[nome];
    const itens = listas[codigo];
    console.log(`\n  ${nome} (${codigo})`);

    if (!itens) {
        alerta('    campo inexistente ou sem lista de valores — nada a comparar');
        continue;
    }

    const porId = new Map(itens.map((i) => [String(i.ID), i.VALUE]));
    for (const [rotulo, id] of Object.entries(mapa)) {
        // O formulário manda o rótulo em inglês/francês e o portal guarda o
        // equivalente em português: comparar o texto não faz sentido, o que
        // importa é o ID existir.
        const valorNoPortal = porId.get(String(id));
        if (!valorNoPortal) falha(`    "${rotulo}" -> ${id}  ID NÃO existe neste portal`);
        else ok(`    "${rotulo}" -> ${id} "${valorNoPortal}"`);
    }

    console.log('    valores disponíveis no portal:');
    for (const i of itens) console.log(`      ${String(i.ID).padEnd(6)} ${i.VALUE}`);
}

console.log(`
  país (${config.campos.pais}), padrão = '${config.lead.paisPadrao}'`);
const itensPais = listas[config.campos.pais];
if (itensPais) {
    const padrao = itensPais.find((i) => String(i.ID) === String(config.lead.paisPadrao));
    if (padrao) ok(`    padrão existe: "${padrao.VALUE}"`);
    else falha('    país padrão NÃO existe neste portal');

    const invalidos = Object.keys(MAPA_PAIS).filter((n) => !itensPais.some((i) => String(i.ID) === String(MAPA_PAIS[n])));
    if (invalidos.length) falha(`    ${invalidos.length} nomes do MAPA_PAIS apontam para IDs inexistentes`);
    else ok(`    MAPA_PAIS: ${Object.keys(MAPA_PAIS).length} nomes, todos com ID válido`);
}

console.log('');
