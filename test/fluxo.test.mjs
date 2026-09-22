// Testes do fluxo completo contra um Bitrix simulado em memória.
//
// Regras do cliente (22/09/2026) que estes testes garantem:
//  - e-mail de formulário dos canais configurados vira lead, com DE/PARA;
//  - e-mail de qualquer outro canal NÃO é tocado (o marketing avalia);
//  - lead criado à mão nunca é sobrescrito;
//  - a integração NUNCA exclui lead (apagar faz a sincronização recriá-lo).
//
// Toda rodada termina conferindo que nada foi excluído.

import assert from 'assert';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------- Bitrix simulado ----------

let estado;
function resetar() {
    estado = { atividades: {}, leads: {}, chamadas: [], excluidos: [], posts: [], vinculos: [], proximoId: 50000, proximoEmailId: 1000 };
}
resetar();

function aplicarMultifield(lead, campo, entradas) {
    let atuais = (lead[campo] || []).slice();
    for (const e of entradas || []) {
        if (e.ID && e.VALUE === '') atuais = atuais.filter((x) => String(x.ID) !== String(e.ID));
        else if (!e.ID) atuais.push({ ID: String(estado.proximoEmailId++), TYPE_ID: e.TYPE_ID, VALUE: e.VALUE });
    }
    lead[campo] = atuais;
}

const bitrix = http.createServer((req, res) => {
    let corpo = '';
    req.on('data', (c) => (corpo += c));
    req.on('end', () => {
        const metodo = req.url.split('/').pop();
        const p = corpo ? JSON.parse(corpo) : {};
        estado.chamadas.push(metodo);
        let result = true;

        if (metodo === 'crm.activity.get') result = estado.atividades[p.ID] || null;
        else if (metodo === 'crm.lead.get') result = estado.leads[p.ID] || null;
        else if (metodo === 'crm.lead.list') {
            const f = p.FILTER || {};
            result = Object.values(estado.leads).filter((l) =>
                (!f.EMAIL || (l.EMAIL || []).some((e) => e.VALUE === f.EMAIL))
                && (!f['!ID'] || String(l.ID) !== String(f['!ID'])));
        } else if (metodo === 'crm.lead.add') {
            const id = String(estado.proximoId++);
            const { EMAIL, PHONE, ...resto } = p.fields;
            estado.leads[id] = { ID: id, DATE_CREATE: new Date().toISOString(), ...resto, EMAIL: [], PHONE: [] };
            aplicarMultifield(estado.leads[id], 'EMAIL', EMAIL);
            aplicarMultifield(estado.leads[id], 'PHONE', PHONE);
            result = id;
        } else if (metodo === 'crm.lead.update') {
            const l = estado.leads[p.ID];
            const { EMAIL, PHONE, ...resto } = p.FIELDS;
            Object.assign(l, resto);
            if (EMAIL) aplicarMultifield(l, 'EMAIL', EMAIL);
            if (PHONE) aplicarMultifield(l, 'PHONE', PHONE);
        } else if (metodo === 'crm.lead.delete') {
            estado.excluidos.push(String(p.ID));
            delete estado.leads[p.ID];
        } else if (metodo === 'crm.activity.binding.add') {
            estado.vinculos.push({ atividade: String(p.activityId), lead: String(p.entityId) });
        } else if (metodo === 'crm.timeline.comment.add') {
            estado.posts.push({ lead: String(p.fields.ENTITY_ID), texto: p.fields.COMMENT, tipo: p.fields.ENTITY_TYPE });
        } else if (metodo === 'crm.livefeedmessage.add') {
            // como no portal real: o método existe mas foi desativado
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({ error: '', error_description: 'Livefeed is no longer supported' }));
        }

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ result, total: Array.isArray(result) ? result.length : undefined }));
    });
});

await new Promise((r) => bitrix.listen(0, '127.0.0.1', r));
process.env.BITRIX_WEBHOOK = `http://127.0.0.1:${bitrix.address().port}/rest`;
process.env.BITRIX_INTERVALO_MS = '0';
const CSV_DEVOLUCOES = path.join(os.tmpdir(), `devolucoes-teste-${process.pid}.csv`);
process.env.ARQUIVO_DEVOLUCOES = CSV_DEVOLUCOES;

const { default: topSolid, ehRemetenteAutomatico, ehLeadDeRemetenteAutomatico } = await import('../src/topSolid.js');
const { ehMesmaSubmissao, ehLeadAutomaticoIntocado } = await import('../src/lead.js');
const { lerNotificacao } = await import('../src/devolucao.js');

const lerCsv = () => (fs.existsSync(CSV_DEVOLUCOES) ? fs.readFileSync(CSV_DEVOLUCOES, 'utf8') : '');
const limparCsv = () => { if (fs.existsSync(CSV_DEVOLUCOES)) fs.unlinkSync(CSV_DEVOLUCOES); };

const logOriginal = console.log;
const calado = () => {};

// ---------- ajudantes ----------

const CAIXA = 'marketing@topsolidbrazil.com';
const agoraIso = (ms = 0) => new Date(Date.now() + ms).toISOString();
const DIA = 864e5;

function email(id, { de, assunto, dono, tipoDono = 1, corpo = '', chegouMs = 0 }) {
    estado.atividades[id] = {
        ID: String(id), PROVIDER_ID: 'CRM_EMAIL', PROVIDER_TYPE_ID: 'EMAIL_COMPRESSED',
        SUBJECT: assunto, OWNER_ID: String(dono), OWNER_TYPE_ID: String(tipoDono), DESCRIPTION: corpo,
        START_TIME: agoraIso(chegouMs), CREATED: agoraIso(chegouMs),
        SETTINGS: { EMAIL_META: { __email: CAIXA, from: de } },
    };
}

function lead(id, { email: end, origem = 'EMAIL', assunto = '', criadoMs = 0, titulo = '', status = 'NEW' }) {
    estado.leads[id] = {
        ID: String(id), TITLE: titulo || end, SOURCE_ID: origem, SOURCE_DESCRIPTION: assunto, STATUS_ID: status,
        DATE_CREATE: agoraIso(criadoMs),
        EMAIL: end ? [{ ID: String(estado.proximoEmailId++), TYPE_ID: 'EMAIL', VALUE: end }] : [],
        PHONE: [],
    };
}

const FORMULARIO = `<p><strong>E-mail:</strong> <a href="mailto:vinicius@ds.ind.br">vinicius@ds.ind.br</a></p>
<p>Last Name: Watanabe</p><p>First Name: Vinicius</p><p>Company: D.S SCHIAVETTO</p>
<p>Zip Code: 15000-000</p><p>Country: Brazil</p><p>Industry Interest: Woodworking</p>
<p>Phone: 17 3227-1446</p><p>Message: Quero orçamento</p><p>TOPSOLID SAS</p>`;

const DEVOLUCAO = `<p>Delivery has failed to these recipients or groups:</p>
<p><a href="mailto:paulomovelatto@hotmail.com">paulomovelatto@hotmail.com</a></p>
<p>Diagnostic information for administrators: Remote server returned '550 5.5.0 Requested action not taken: mailbox unavailable'</p>
<p>Reporting-MTA: dns; a1-2.smtp-out.sa-east-1.amazonses.com</p>`;

const HUBSPOT = 'Hubspot Landing <mkt.sales@topsolid.com>';

let ok = 0, falhas = 0;
async function t(nome, fn) {
    resetar();
    console.log = calado;
    try {
        await fn();
        // regra do cliente: a integração nunca exclui lead, em cenário nenhum
        assert.deepStrictEqual(estado.excluidos, [], `a integração NUNCA pode excluir lead (excluiu ${estado.excluidos})`);
        console.log = logOriginal;
        ok++; console.log('  ok  -', nome);
    } catch (e) {
        console.log = logOriginal;
        falhas++; console.log('  FALHA -', nome, '\n      ', e.message);
    }
}

let seq = 90000;
const rodar = async (id) => { await topSolid(String(id)); };

// ---------- regras puras ----------

await t('remetente automático: devolução, supressão e reclamação são reconhecidos', async () => {
    for (const r of ['"MAILER-DAEMON@sa-east-1.amazonses.com"', 'complaints@sa-east-1.email-abuse.amazonses.com', 'postmaster@exemplo.com.br']) {
        assert.strictEqual(ehRemetenteAutomatico(r), true, r);
    }
});

await t('REGRESSAO: remetentes dos formulários NÃO são tratados como automáticos', async () => {
    for (const r of ['TopSolid <no-reply@topsolid.com>', HUBSPOT, 'CadSolid <marketing@cadsolid.pt>', 'Marcos <marcos@ferkoda.com>']) {
        assert.strictEqual(ehRemetenteAutomatico(r), false, r);
    }
});

await t('lead-lixo com EMAIL vazio é reconhecido; pessoa real sem e-mail não', async () => {
    assert.strictEqual(ehLeadDeRemetenteAutomatico({ EMAIL: [], NAME: 'complaints@sa-east-1.email-abuse.amazonses.com', TITLE: '' }), true);
    assert.strictEqual(ehLeadDeRemetenteAutomatico({ EMAIL: [], NAME: 'João Silva', TITLE: 'Móveis Silva , E-Mail' }), false);
    assert.strictEqual(ehLeadDeRemetenteAutomatico({ EMAIL: [], NAME: 'marcos@ferkoda.com', TITLE: '' }), false);
});

await t('mesma submissão: mesmo assunto dentro de 30 min', async () => {
    const agora = Date.now();
    const l = (assunto, minAtras) => ({ SOURCE_DESCRIPTION: assunto, DATE_CREATE: new Date(agora - minAtras * 60e3).toISOString() });
    assert.strictEqual(ehMesmaSubmissao(l('Get a quote', 0.02), 'Get a quote', agora), true);
    assert.strictEqual(ehMesmaSubmissao(l('Get a quote', 29), 'Get a quote', agora), true);
    assert.strictEqual(ehMesmaSubmissao(l('Get a quote', 31), 'Get a quote', agora), false, 'fora da janela');
    assert.strictEqual(ehMesmaSubmissao(l('Demo request', 1), 'Get a quote', agora), false, 'outro formulário');
});

await t('lead automático x lead feito à mão: decidido pelo tempo entre o e-mail e o lead', async () => {
    const agora = Date.now();
    const ativ = { START_TIME: new Date(agora).toISOString() };
    const l = (origem, minDepois) => ({ SOURCE_ID: origem, DATE_CREATE: new Date(agora + minDepois * 60e3).toISOString() });
    assert.strictEqual(ehLeadAutomaticoIntocado(l('EMAIL', 5), ativ), true, 'sincronização: minutos depois');
    assert.strictEqual(ehLeadAutomaticoIntocado(l('EMAIL', 3 * 60), ativ), false, 'convertido à mão horas depois');
    assert.strictEqual(ehLeadAutomaticoIntocado(l('CALL', 1), ativ), false, 'origem mudada = trabalhado');
    assert.strictEqual(ehLeadAutomaticoIntocado(l('WEBFORM', 1), ativ), false, 'já preenchido');
});

// ---------- formulário "Get a quote" (lead criado pela sincronização) ----------

await t('QUOTE: formulário preenche o lead que a sincronização criou', async () => {
    lead(1100, { email: 'mkt.sales@topsolid.com' });
    email(++seq, { de: HUBSPOT, assunto: 'Get a quote', dono: 1100, corpo: FORMULARIO });
    await rodar(seq);
    const l = estado.leads[1100];
    assert.strictEqual(l.SOURCE_ID, 'WEBFORM');
    assert.strictEqual(l.TITLE, 'D.S SCHIAVETTO');
    assert.strictEqual(l.SOURCE_DESCRIPTION, 'Get a quote');
    assert.deepStrictEqual(l.EMAIL.map((e) => e.VALUE), ['vinicius@ds.ind.br'], 'o e-mail do canal sai, o do cliente entra');
});

await t('DE/PARA: o resumo registra por qual canal e para qual caixa o formulário chegou', async () => {
    lead(1150, { email: 'mkt.sales@topsolid.com' });
    email(++seq, { de: HUBSPOT, assunto: 'Get a quote', dono: 1150, corpo: FORMULARIO });
    await rodar(seq);
    const resumo = estado.posts.find((p) => p.lead === '1150');
    assert.ok(resumo, 'resumo publicado');
    assert.match(resumo.texto, /Recebido de:\[\/b\] Hubspot Landing <mkt\.sales@topsolid\.com>/);
    assert.match(resumo.texto, /Para:\[\/b\] marketing@topsolidbrazil\.com/);
    assert.strictEqual(resumo.tipo, 'lead', 'publicado na linha do tempo, não no livefeed desativado');
    // o Reply-To do Hubspot é o canal: o resumo avisa para responder pelo cartão
    assert.match(resumo.texto, /use "E-mail" neste cartão \(vai para vinicius@ds\.ind\.br\)/);
    assert.match(resumo.texto, /vai para mkt\.sales@topsolid\.com, não para o cliente/);
});

await t('QUOTE: mesma pessoa pedindo orçamento de novo DIAS depois é conversão nova', async () => {
    lead(1200, { email: 'vinicius@ds.ind.br', origem: 'WEBFORM', assunto: 'Get a quote', criadoMs: -3 * DIA });
    lead(1201, { email: 'mkt.sales@topsolid.com' });
    email(++seq, { de: HUBSPOT, assunto: 'Get a quote', dono: 1201, corpo: FORMULARIO });
    await rodar(seq);
    assert.strictEqual(estado.leads[1201].SOURCE_ID, 'WEBFORM');
    assert.notStrictEqual(estado.leads[1201].STATUS_ID, 'JUNK');
});

await t('QUOTE: funciona pelos três canais de formulário', async () => {
    const canais = ['TopSolid <no-reply@topsolid.com>', HUBSPOT, 'CadSolid <marketing@cadsolid.pt>'];
    for (const [i, de] of canais.entries()) {
        const id = 1300 + i;
        lead(id, { email: 'canal@x.com' });
        email(++seq, { de, assunto: 'Get a quote', dono: id, corpo: FORMULARIO.replace(/vinicius@ds\.ind\.br/g, `cliente${i}@exemplo.com.br`) });
        await rodar(seq);
        assert.strictEqual(estado.leads[id].SOURCE_ID, 'WEBFORM', `não preencheu vindo de ${de}`);
    }
});

// ---------- submissão repetida: marca, nunca apaga ----------

await t('REPETIDA: 2º cartão vira Desqualificado, perde o e-mail do canal e o original é avisado', async () => {
    lead(31597, { email: 'mkt.sales@topsolid.com' });
    email(++seq, { de: HUBSPOT, assunto: 'Get a quote', dono: 31597, corpo: FORMULARIO });
    await rodar(seq);

    lead(31598, { email: 'mkt.sales@topsolid.com', criadoMs: 1000 });
    email(++seq, { de: HUBSPOT, assunto: 'Get a quote', dono: 31598, corpo: FORMULARIO });
    await rodar(seq);

    const dup = estado.leads[31598];
    assert.ok(dup, 'o duplicado continua existindo');
    assert.strictEqual(dup.STATUS_ID, 'JUNK', 'marcado como Desqualificado');
    assert.deepStrictEqual(dup.EMAIL, [], 'sem o e-mail do canal, senão engole os próximos formulários');
    assert.ok(estado.posts.some((p) => p.lead === '31597' && /chegou novamente/.test(p.texto)), 'aviso no original');
    assert.ok(estado.posts.some((p) => p.lead === '31598' && /DUPLICATA/.test(p.texto)), 'aviso no duplicado');
});

await t('REPETIDA SIMULTÂNEA: a trava por e-mail evita a corrida — só um vira duplicata', async () => {
    lead(700, { email: 'mkt.sales@topsolid.com' });
    lead(701, { email: 'mkt.sales@topsolid.com', criadoMs: 1000 });
    email(++seq, { de: HUBSPOT, assunto: 'Get a quote', dono: 700, corpo: FORMULARIO });
    const a = seq;
    email(++seq, { de: HUBSPOT, assunto: 'Get a quote', dono: 701, corpo: FORMULARIO });
    const b = seq;
    await Promise.all([rodar(a), rodar(b)]);
    const junk = Object.values(estado.leads).filter((l) => l.STATUS_ID === 'JUNK');
    assert.strictEqual(junk.length, 1, `exatamente um duplicado, foram ${junk.length}`);
    assert.strictEqual(Object.keys(estado.leads).length, 2, 'os dois cartões continuam existindo');
});

await t('mesma pessoa, formulário DIFERENTE: não é duplicata', async () => {
    lead(800, { email: 'mkt.sales@topsolid.com' });
    email(++seq, { de: HUBSPOT, assunto: 'Get a quote', dono: 800, corpo: FORMULARIO });
    await rodar(seq);
    lead(801, { email: 'mkt.sales@topsolid.com', criadoMs: 1000 });
    email(++seq, { de: HUBSPOT, assunto: 'Demo request', dono: 801, corpo: FORMULARIO });
    await rodar(seq);
    assert.ok(!Object.values(estado.leads).some((l) => l.STATUS_ID === 'JUNK'));
});

// ---------- lead feito à mão ----------

await t('MANUAL: lead que o marketing criou à mão não é sobrescrito', async () => {
    // e-mail chegou há 2 dias; o marketing avaliou e converteu hoje
    lead(1400, { email: 'mkt.sales@topsolid.com', titulo: 'Criado pelo marketing' });
    estado.leads[1400].NAME = 'Nome digitado à mão';
    email(++seq, { de: HUBSPOT, assunto: 'Get a quote', dono: 1400, corpo: FORMULARIO, chegouMs: -2 * DIA });
    await rodar(seq);
    const l = estado.leads[1400];
    assert.strictEqual(l.TITLE, 'Criado pelo marketing', 'título preservado');
    assert.strictEqual(l.NAME, 'Nome digitado à mão', 'nome preservado');
    assert.strictEqual(l.SOURCE_ID, 'EMAIL', 'origem preservada');
    assert.ok(!estado.chamadas.includes('crm.lead.update'), 'nenhum campo alterado');
    assert.ok(estado.posts.some((p) => p.lead === '1400' && /Informações Brutas/.test(p.texto)), 'dados do formulário só como comentário');
});

await t('MANUAL: lead já trabalhado (origem mudada) não é sobrescrito', async () => {
    lead(1401, { email: 'mkt.sales@topsolid.com', origem: 'CALL', titulo: 'Vendedor ligou' });
    email(++seq, { de: HUBSPOT, assunto: 'Get a quote', dono: 1401, corpo: FORMULARIO });
    await rodar(seq);
    assert.strictEqual(estado.leads[1401].TITLE, 'Vendedor ligou');
    assert.ok(!estado.chamadas.includes('crm.lead.update'));
});

// ---------- outros canais: nada é tocado ----------

await t('OUTRO CANAL: pessoa escrevendo para o marketing — lead intocado', async () => {
    lead(31600, { email: 'marcos@ferkoda.com', titulo: 'Ferkoda S/A' });
    email(++seq, { de: 'Marcos <marcos@ferkoda.com>', assunto: 'Orçamento de licenças', dono: 31600 });
    await rodar(seq);
    assert.strictEqual(estado.leads[31600].TITLE, 'Ferkoda S/A');
    assert.ok(!estado.chamadas.includes('crm.lead.update'), 'nada alterado');
    assert.ok(!estado.chamadas.includes('crm.lead.add'), 'nenhum lead criado');
});

await t('OUTRO CANAL: e-mail de flyer/QR code da feira — nada criado nem alterado', async () => {
    lead(1500, { email: 'visitante@gmail.com' });
    email(++seq, { de: 'Visitante <visitante@gmail.com>', assunto: 'Vi o panfleto na feira', dono: 1500 });
    await rodar(seq);
    assert.ok(!estado.chamadas.some((c) => ['crm.lead.update', 'crm.lead.add'].includes(c)));
});

await t('CANAL DE FORMULÁRIO com assunto que não é formulário: nada alterado', async () => {
    lead(901, { email: 'no-reply@topsolid.com' });
    email(++seq, { de: 'TopSolid <no-reply@topsolid.com>', assunto: 'Newsletter de setembro', dono: 901 });
    await rodar(seq);
    assert.ok(!estado.chamadas.some((c) => ['crm.lead.update', 'crm.lead.add'].includes(c)));
});

await t('resposta (RE:) nunca é processada', async () => {
    lead(902, { email: 'no-reply@topsolid.com' });
    email(++seq, { de: 'TopSolid <no-reply@topsolid.com>', assunto: 'RE: Get a quote', dono: 902, corpo: FORMULARIO });
    await rodar(seq);
    assert.ok(!estado.chamadas.includes('crm.lead.update'));
});

// ---------- devoluções ----------

await t('devolução: extrai destinatário, motivo e tipo', async () => {
    const r = lerNotificacao({ DESCRIPTION: DEVOLUCAO, SUBJECT: 'Não é possível entregar: XIV Encontro Tecnológico', CREATED: '2026-09-22' });
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].email, 'paulomovelatto@hotmail.com');
    assert.strictEqual(r[0].tipo, 'permanente');
    assert.strictEqual(r[0].campanha, 'XIV Encontro Tecnológico');
});

await t('devolução: endereço vai para o CSV e o cartão do mailer-daemon sai do funil', async () => {
    limparCsv();
    lead(31553, { email: 'mailer-daemon@sa-east-1.amazonses.com' });
    email(++seq, { de: 'MAILER-DAEMON@sa-east-1.amazonses.com', assunto: 'Não é possível entregar: XIV Encontro', dono: 31553, corpo: DEVOLUCAO });
    await rodar(seq);
    assert.match(lerCsv(), /paulomovelatto@hotmail\.com;permanente;/);
    const l = estado.leads[31553];
    assert.ok(l, 'o lead continua existindo');
    assert.strictEqual(l.STATUS_ID, 'JUNK');
    // o endereço fica: as próximas devoluções caem neste cartão, não em um novo
    assert.deepStrictEqual(l.EMAIL.map((e) => e.VALUE), ['mailer-daemon@sa-east-1.amazonses.com']);
    assert.ok(estado.posts.some((p) => p.lead === '31553' && /Desqualificado/.test(p.texto)));
});

await t('devolução: reclamação com o endereço só no título também sai do funil', async () => {
    lead(31613, { titulo: 'complaints@sa-east-1.email-abuse.amazonses.com' });
    email(++seq, { de: 'complaints@sa-east-1.email-abuse.amazonses.com', assunto: 'Complaint', dono: 31613 });
    await rodar(seq);
    assert.strictEqual(estado.leads[31613].STATUS_ID, 'JUNK');
});

await t('devolução: dezenas chegando juntas mexem no cartão uma vez só', async () => {
    lead(31612, { email: 'mailer-daemon@sa-east-1.amazonses.com' });
    const ids = [];
    for (let i = 0; i < 10; i++) {
        email(++seq, { de: 'MAILER-DAEMON@sa-east-1.amazonses.com', assunto: 'Não é possível entregar', dono: 31612, corpo: DEVOLUCAO });
        ids.push(seq);
    }
    await Promise.all(ids.map(rodar));
    assert.strictEqual(estado.leads[31612].STATUS_ID, 'JUNK');
    assert.strictEqual(estado.chamadas.filter((c) => c === 'crm.lead.update').length, 1);
    assert.strictEqual(estado.posts.filter((p) => p.lead === '31612').length, 1);
});

await t('devolução: lead de PESSOA ou já trabalhado nunca é desqualificado', async () => {
    lead(1700, { email: 'cliente@empresa.com.br' });
    email(++seq, { de: 'MAILER-DAEMON@sa-east-1.amazonses.com', assunto: 'Não é possível entregar', dono: 1700, corpo: DEVOLUCAO });
    await rodar(seq);
    lead(1701, { email: 'mailer-daemon@sa-east-1.amazonses.com', status: 'IN_PROCESS' });
    email(++seq, { de: 'MAILER-DAEMON@sa-east-1.amazonses.com', assunto: 'Não é possível entregar', dono: 1701, corpo: DEVOLUCAO });
    await rodar(seq);
    lead(1702, { email: 'mailer-daemon@sa-east-1.amazonses.com', origem: 'WEBFORM' });
    email(++seq, { de: 'MAILER-DAEMON@sa-east-1.amazonses.com', assunto: 'Não é possível entregar', dono: 1702, corpo: DEVOLUCAO });
    await rodar(seq);
    assert.strictEqual(estado.leads[1700].STATUS_ID, 'NEW');
    assert.strictEqual(estado.leads[1701].STATUS_ID, 'IN_PROCESS');
    assert.strictEqual(estado.leads[1702].STATUS_ID, 'NEW');
    assert.ok(!estado.chamadas.includes('crm.lead.update'));
});

// ---------- contato de canal: a integração cria o lead ----------

await t('CONTATO DE CANAL: formulário cria um lead novo com o e-mail vinculado', async () => {
    // cenário com a criação automática da caixa desligada: o e-mail do
    // formulário cai num contato fixo que representa o canal
    email(++seq, { de: HUBSPOT, assunto: 'Get a quote', dono: 7, tipoDono: 3, corpo: FORMULARIO });
    const atividade = String(seq);
    await rodar(seq);
    const novos = Object.values(estado.leads);
    assert.strictEqual(novos.length, 1, 'um lead criado');
    const l = novos[0];
    assert.strictEqual(l.SOURCE_ID, 'WEBFORM');
    assert.strictEqual(l.TITLE, 'D.S SCHIAVETTO');
    assert.deepStrictEqual(l.EMAIL.map((e) => e.VALUE), ['vinicius@ds.ind.br']);
    assert.deepStrictEqual(estado.vinculos, [{ atividade, lead: l.ID }], 'e-mail original vinculado ao lead');
    assert.ok(estado.posts.some((p) => p.lead === l.ID && /Recebido de/.test(p.texto)), 'resumo com DE/PARA');
});

await t('CONTATO DE CANAL: submissão repetida não cria segundo lead', async () => {
    email(++seq, { de: HUBSPOT, assunto: 'Get a quote', dono: 7, tipoDono: 3, corpo: FORMULARIO });
    await rodar(seq);
    email(++seq, { de: HUBSPOT, assunto: 'Get a quote', dono: 7, tipoDono: 3, corpo: FORMULARIO });
    await rodar(seq);
    assert.strictEqual(Object.keys(estado.leads).length, 1, 'um lead só');
    assert.ok(estado.posts.some((p) => /chegou novamente/.test(p.texto)));
});

await t('CONTATO de outro canal: nenhum lead criado', async () => {
    email(++seq, { de: 'Marcos <marcos@ferkoda.com>', assunto: 'Get a quote', dono: 8, tipoDono: 3, corpo: FORMULARIO });
    await rodar(seq);
    assert.ok(!estado.chamadas.includes('crm.lead.add'));
});

await t('SEGURANÇA: formulário anexado a NEGÓCIO não altera lead nenhum', async () => {
    lead(55, { email: 'algum@lead.com' });   // um lead com o mesmo número do negócio
    email(++seq, { de: HUBSPOT, assunto: 'Get a quote', dono: 55, tipoDono: 2, corpo: FORMULARIO });
    await rodar(seq);
    assert.ok(!estado.chamadas.some((c) => ['crm.lead.update', 'crm.lead.add'].includes(c)),
        'não pode confundir o ID do negócio com o de um lead');
});

bitrix.close();
limparCsv();
console.log(`\n${ok} passaram, ${falhas} falharam`);
process.exit(falhas ? 1 : 0);
