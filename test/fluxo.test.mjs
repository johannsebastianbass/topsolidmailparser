// Testes do fluxo completo contra um Bitrix simulado em memória.
// Cobrem sobretudo as regras de EXCLUSÃO — é onde um erro apaga cliente.
// Cada cenário reproduz um caso real observado em 22/09/2026.

import assert from 'assert';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------- Bitrix simulado ----------

let estado;
function resetar() {
    estado = { atividades: {}, leads: {}, chamadas: [], excluidos: [], posts: [], proximoEmailId: 1000 };
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
        } else if (metodo === 'crm.lead.update') {
            const l = estado.leads[p.ID];
            const { EMAIL, PHONE, ...resto } = p.FIELDS;
            Object.assign(l, resto);
            if (EMAIL) aplicarMultifield(l, 'EMAIL', EMAIL);
            if (PHONE) aplicarMultifield(l, 'PHONE', PHONE);
        } else if (metodo === 'crm.lead.delete') {
            estado.excluidos.push(String(p.ID));
            delete estado.leads[p.ID];
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

const { default: config } = await import('../src/config.js');
const { default: topSolid, ehRemetenteAutomatico, ehLeadDeRemetenteAutomatico } = await import('../src/topSolid.js');
const { ehMesmaSubmissao } = await import('../src/lead.js');
const { lerNotificacao } = await import('../src/devolucao.js');

const lerCsv = () => (fs.existsSync(CSV_DEVOLUCOES) ? fs.readFileSync(CSV_DEVOLUCOES, 'utf8') : '');
const limparCsv = () => { if (fs.existsSync(CSV_DEVOLUCOES)) fs.unlinkSync(CSV_DEVOLUCOES); };

// corpo real de uma devolução da SES (atividade 6329)
const DEVOLUCAO = `<p>Delivery has failed to these recipients or groups:</p>
<p><a href="mailto:paulomovelatto@hotmail.com">paulomovelatto@hotmail.com</a></p>
<p>Diagnostic information for administrators: Remote server returned '550 5.5.0 Requested action not taken: mailbox unavailable'</p>
<p>Reporting-MTA: dns; a1-2.smtp-out.sa-east-1.amazonses.com</p>`;

// silencia o log da aplicação durante os testes
const logOriginal = console.log;
const calado = () => {};

// ---------- ajudantes ----------

const CAIXA = 'marketing@topsolidbrazil.com';
const agoraIso = (ms = 0) => new Date(Date.now() + ms).toISOString();

function email(id, { de, assunto, lead, corpo = '', owner = 1 }) {
    estado.atividades[id] = {
        ID: String(id), PROVIDER_ID: 'CRM_EMAIL', PROVIDER_TYPE_ID: 'EMAIL_COMPRESSED',
        SUBJECT: assunto, OWNER_ID: String(lead), OWNER_TYPE_ID: String(owner), DESCRIPTION: corpo,
        SETTINGS: { EMAIL_META: { __email: CAIXA, from: de } },
    };
}

function lead(id, { email: end, origem = 'EMAIL', assunto = '', criadoMs = 0, titulo = '' }) {
    estado.leads[id] = {
        ID: String(id), TITLE: titulo || end, SOURCE_ID: origem, SOURCE_DESCRIPTION: assunto,
        DATE_CREATE: agoraIso(criadoMs), EMAIL: end ? [{ ID: String(estado.proximoEmailId++), TYPE_ID: 'EMAIL', VALUE: end }] : [],
    };
}

const FORMULARIO = `<p><strong>E-mail:</strong> <a href="mailto:vinicius@ds.ind.br">vinicius@ds.ind.br</a></p>
<p>Last Name: Watanabe</p><p>First Name: Vinicius</p><p>Company: D.S SCHIAVETTO</p>
<p>Zip Code: 15000-000</p><p>Country: Brazil</p><p>Industry Interest: Woodworking</p>
<p>Phone: 17 3227-1446</p><p>Message: Quero orçamento</p><p>TOPSOLID SAS</p>`;

let ok = 0, falhas = 0;
async function t(nome, fn) {
    resetar();
    console.log = calado;
    try {
        await fn();
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
    for (const r of ['TopSolid <no-reply@topsolid.com>', 'Hubspot Landing <mkt.sales@topsolid.com>', 'CadSolid <marketing@cadsolid.pt>', 'Marcos <marcos@ferkoda.com>']) {
        assert.strictEqual(ehRemetenteAutomatico(r), false, r);
    }
});

await t('mesma submissão: mesmo assunto dentro de 30 min', async () => {
    const agora = Date.now();
    const l = (assunto, minAtras) => ({ SOURCE_DESCRIPTION: assunto, DATE_CREATE: new Date(agora - minAtras * 60e3).toISOString() });
    assert.strictEqual(ehMesmaSubmissao(l('Get a quote', 0.02), 'Get a quote', agora), true);
    assert.strictEqual(ehMesmaSubmissao(l('Get a quote', 29), 'Get a quote', agora), true);
    assert.strictEqual(ehMesmaSubmissao(l('Get a quote', 31), 'Get a quote', agora), false, 'fora da janela');
    assert.strictEqual(ehMesmaSubmissao(l('Demo request', 1), 'Get a quote', agora), false, 'outro formulário');
});

// ---------- devoluções e reclamações ----------

await t('devolução: apaga o lead-lixo "mailer-daemon" quando a exclusão está ligada', async () => {
    config.excluirLeadDesconhecido = true;
    lead(31553, { email: 'mailer-daemon@sa-east-1.amazonses.com' });
    email(++seq, { de: '"MAILER-DAEMON@sa-east-1.amazonses.com"', assunto: 'Não é possível entregar: XIV Encontro', lead: 31553 });
    await rodar(seq);
    assert.deepStrictEqual(estado.excluidos, ['31553']);
});

await t('reclamação: apaga o lead-lixo "complaints@..."', async () => {
    config.excluirLeadDesconhecido = true;
    lead(31599, { email: 'complaints@sa-east-1.email-abuse.amazonses.com' });
    email(++seq, { de: 'complaints@sa-east-1.email-abuse.amazonses.com', assunto: 'Email Feedback Report (Complaint)', lead: 31599 });
    await rodar(seq);
    assert.deepStrictEqual(estado.excluidos, ['31599']);
});

await t('REGRESSAO: reclamação com EMAIL VAZIO (endereço só no nome) também é limpa', async () => {
    config.excluirLeadDesconhecido = true;
    // exatamente como o Bitrix gravou os leads 31593/31595/31596/31599
    estado.leads[31593] = { ID: '31593', SOURCE_ID: 'EMAIL', EMAIL: [], DATE_CREATE: agoraIso(),
        NAME: 'complaints@sa-east-1.email-abuse.amazonses.com',
        TITLE: 'complaints@sa-east-1.email-abuse.amazonses.com , E-Mail' };
    email(++seq, { de: 'complaints@sa-east-1.email-abuse.amazonses.com', assunto: 'Email Feedback Report (Complaint)', lead: 31593 });
    await rodar(seq);
    assert.deepStrictEqual(estado.excluidos, ['31593']);
});

await t('SEGURANÇA: pessoa real com EMAIL vazio (nome comum) nunca é tratada como automática', async () => {
    assert.strictEqual(ehLeadDeRemetenteAutomatico({ EMAIL: [], NAME: 'João Silva', TITLE: 'Móveis Silva , E-Mail' }), false);
    assert.strictEqual(ehLeadDeRemetenteAutomatico({ EMAIL: [], NAME: 'marcos@ferkoda.com', TITLE: '' }), false, 'endereço real no nome');
    assert.strictEqual(ehLeadDeRemetenteAutomatico({ EMAIL: [], NAME: '', TITLE: '' }), false, 'sem nada');
});

await t('devolução: extrai o destinatário que falhou, o motivo e o tipo', async () => {
    const r = lerNotificacao({ DESCRIPTION: DEVOLUCAO, SUBJECT: 'Não é possível entregar: XIV Encontro Tecnológico', CREATED: '2026-09-22' });
    assert.strictEqual(r.length, 1, `esperava 1 endereço, veio ${JSON.stringify(r)}`);
    assert.strictEqual(r[0].email, 'paulomovelatto@hotmail.com');
    assert.strictEqual(r[0].tipo, 'permanente');
    assert.match(r[0].motivo, /550/);
    assert.strictEqual(r[0].campanha, 'XIV Encontro Tecnológico');
});

await t('devolução: endereço é gravado no CSV ANTES de apagar o lead', async () => {
    limparCsv();
    config.excluirLeadDesconhecido = true;
    lead(31553, { email: 'mailer-daemon@sa-east-1.amazonses.com' });
    email(++seq, { de: 'MAILER-DAEMON@sa-east-1.amazonses.com', assunto: 'Não é possível entregar: XIV Encontro', lead: 31553, corpo: DEVOLUCAO });
    await rodar(seq);
    assert.deepStrictEqual(estado.excluidos, ['31553'], 'o lead-lixo sai');
    assert.match(lerCsv(), /paulomovelatto@hotmail\.com;permanente;/, 'mas o endereço fica registrado');
});

await t('devolução: CSV é gravado mesmo com a exclusão DESLIGADA', async () => {
    limparCsv();
    config.excluirLeadDesconhecido = false;
    lead(31553, { email: 'mailer-daemon@sa-east-1.amazonses.com' });
    email(++seq, { de: 'MAILER-DAEMON@sa-east-1.amazonses.com', assunto: 'Undeliverable: X', lead: 31553, corpo: DEVOLUCAO });
    await rodar(seq);
    assert.deepStrictEqual(estado.excluidos, []);
    assert.match(lerCsv(), /paulomovelatto@hotmail\.com/, 'capturar o endereço não pode depender de apagar');
});

await t('SEGURANÇA: devolução anexada a um CLIENTE REAL não apaga o cliente', async () => {
    config.excluirLeadDesconhecido = true;
    lead(500, { email: 'comprador@empresareal.com.br' });
    email(++seq, { de: 'MAILER-DAEMON@sa-east-1.amazonses.com', assunto: 'Undeliverable: proposta', lead: 500 });
    await rodar(seq);
    assert.deepStrictEqual(estado.excluidos, []);
    assert.ok(estado.leads[500], 'o lead do cliente tem que continuar existindo');
});

await t('SEGURANÇA: lead-lixo que alguém já trabalhou (origem mudou) não é apagado', async () => {
    config.excluirLeadDesconhecido = true;
    lead(501, { email: 'mailer-daemon@sa-east-1.amazonses.com', origem: 'CALL' });
    email(++seq, { de: 'MAILER-DAEMON@sa-east-1.amazonses.com', assunto: 'Undeliverable', lead: 501 });
    await rodar(seq);
    assert.deepStrictEqual(estado.excluidos, []);
});

await t('SEGURANÇA: com a exclusão DESLIGADA, nada é apagado', async () => {
    config.excluirLeadDesconhecido = false;
    lead(31553, { email: 'mailer-daemon@sa-east-1.amazonses.com' });
    email(++seq, { de: 'MAILER-DAEMON@sa-east-1.amazonses.com', assunto: 'Undeliverable', lead: 31553 });
    await rodar(seq);
    assert.deepStrictEqual(estado.excluidos, []);
});

// ---------- gente de verdade escrevendo para o marketing ----------

await t('SEGURANÇA: e-mail de pessoa real (fora da lista de formulários) mantém o lead intacto', async () => {
    config.excluirLeadDesconhecido = true;
    lead(31600, { email: 'marcos@ferkoda.com' });
    email(++seq, { de: 'Marcos <marcos@ferkoda.com>', assunto: 'Orçamento de licenças', lead: 31600 });
    await rodar(seq);
    assert.deepStrictEqual(estado.excluidos, []);
    assert.ok(!estado.chamadas.includes('crm.lead.update'), 'não pode sobrescrever o lead da pessoa');
});

// ---------- submissão repetida (o duplicado real 31597/31598) ----------

await t('submissão repetida: o 2º cartão é apagado e o original recebe o aviso', async () => {
    config.excluirLeadDesconhecido = true;
    // 1ª notificação: lead 31597 criado pelo Bitrix e preenchido pela integração
    lead(31597, { email: 'mkt.sales@topsolid.com' });
    email(++seq, { de: 'Hubspot Landing <mkt.sales@topsolid.com>', assunto: 'Get a quote', lead: 31597, corpo: FORMULARIO });
    await rodar(seq);
    assert.strictEqual(estado.leads[31597].SOURCE_ID, 'WEBFORM', 'o 1º tem que ser preenchido');

    // 2ª notificação idêntica, 1 segundo depois: lead 31598
    lead(31598, { email: 'mkt.sales@topsolid.com', criadoMs: 1000 });
    email(++seq, { de: 'Hubspot Landing <mkt.sales@topsolid.com>', assunto: 'Get a quote', lead: 31598, corpo: FORMULARIO });
    await rodar(seq);

    assert.deepStrictEqual(estado.excluidos, ['31598'], 'só o duplicado sai');
    assert.ok(estado.leads[31597], 'o original fica');
    assert.ok(estado.posts.some((p) => p.lead === '31597' && /chegou novamente/.test(p.texto)), 'aviso no original');
});

await t('submissão repetida SIMULTÂNEA: a trava por e-mail evita a corrida', async () => {
    config.excluirLeadDesconhecido = true;
    lead(700, { email: 'mkt.sales@topsolid.com' });
    lead(701, { email: 'mkt.sales@topsolid.com', criadoMs: 1000 });
    email(++seq, { de: 'Hubspot Landing <mkt.sales@topsolid.com>', assunto: 'Get a quote', lead: 700, corpo: FORMULARIO });
    const a = seq;
    email(++seq, { de: 'Hubspot Landing <mkt.sales@topsolid.com>', assunto: 'Get a quote', lead: 701, corpo: FORMULARIO });
    const b = seq;
    await Promise.all([rodar(a), rodar(b)]);   // chegam juntas, como o Hubspot manda
    assert.strictEqual(estado.excluidos.length, 1, `exatamente um apagado, foram: ${estado.excluidos}`);
    assert.strictEqual(Object.keys(estado.leads).length, 1, 'sobra um cartão só');
});

await t('submissão repetida com exclusão DESLIGADA: o 2º é preenchido, nunca fica cru', async () => {
    config.excluirLeadDesconhecido = false;
    lead(31597, { email: 'mkt.sales@topsolid.com' });
    email(++seq, { de: 'Hubspot Landing <mkt.sales@topsolid.com>', assunto: 'Get a quote', lead: 31597, corpo: FORMULARIO });
    await rodar(seq);
    lead(31598, { email: 'mkt.sales@topsolid.com', criadoMs: 1000 });
    email(++seq, { de: 'Hubspot Landing <mkt.sales@topsolid.com>', assunto: 'Get a quote', lead: 31598, corpo: FORMULARIO });
    await rodar(seq);
    assert.deepStrictEqual(estado.excluidos, []);
    assert.strictEqual(estado.leads[31598].SOURCE_ID, 'WEBFORM', 'o 2º tem que estar preenchido');
});

await t('mesma pessoa, formulário DIFERENTE: não é duplicata, os dois ficam', async () => {
    config.excluirLeadDesconhecido = true;
    lead(800, { email: 'mkt.sales@topsolid.com' });
    email(++seq, { de: 'Hubspot Landing <mkt.sales@topsolid.com>', assunto: 'Get a quote', lead: 800, corpo: FORMULARIO });
    await rodar(seq);
    lead(801, { email: 'mkt.sales@topsolid.com', criadoMs: 1000 });
    email(++seq, { de: 'Hubspot Landing <mkt.sales@topsolid.com>', assunto: 'Demo request', lead: 801, corpo: FORMULARIO });
    await rodar(seq);
    assert.deepStrictEqual(estado.excluidos, []);
});

await t('REGRESSAO: resumo do formulário vai para a linha do tempo (livefeed foi desativado)', async () => {
    config.excluirLeadDesconhecido = true;
    lead(950, { email: 'no-reply@topsolid.com' });
    email(++seq, { de: 'TopSolid <no-reply@topsolid.com>', assunto: 'Get a quote', lead: 950, corpo: FORMULARIO });
    await rodar(seq);
    const resumo = estado.posts.find((p) => p.lead === '950');
    assert.ok(resumo, `o resumo tem que ser publicado; chamadas: ${estado.chamadas.join(', ')}`);
    assert.strictEqual(resumo.tipo, 'lead');
    assert.match(resumo.texto, /Informações Brutas/);
    assert.ok(!estado.chamadas.includes('crm.livefeedmessage.add'), 'não pode usar o método desativado');
});

// ---------- o formulário "Get a quote" padrão ----------

await t('QUOTE: formulário normal cria/preenche o lead e NUNCA é apagado (exclusão ligada)', async () => {
    config.excluirLeadDesconhecido = true;
    lead(1100, { email: 'mkt.sales@topsolid.com' });   // como o Bitrix cria: com o e-mail do remetente
    email(++seq, { de: 'Hubspot Landing <mkt.sales@topsolid.com>', assunto: 'Get a quote', lead: 1100, corpo: FORMULARIO });
    await rodar(seq);
    const l = estado.leads[1100];
    assert.ok(l, 'o lead do quote tem que existir');
    assert.deepStrictEqual(estado.excluidos, [], 'nada pode ser apagado');
    assert.strictEqual(l.SOURCE_ID, 'WEBFORM');
    assert.strictEqual(l.TITLE, 'D.S SCHIAVETTO');
    assert.strictEqual(l.SOURCE_DESCRIPTION, 'Get a quote');
    assert.deepStrictEqual(l.EMAIL.map((e) => e.VALUE), ['vinicius@ds.ind.br'], 'e-mail do remetente trocado pelo do cliente');
    assert.ok(estado.posts.some((p) => p.lead === '1100' && /Informações Brutas/.test(p.texto)), 'resumo publicado');
});

await t('QUOTE: mesma pessoa pedindo orçamento de novo DIAS depois não é duplicata', async () => {
    config.excluirLeadDesconhecido = true;
    // quote antigo, de 3 dias atrás, já preenchido
    lead(1200, { email: 'vinicius@ds.ind.br', origem: 'WEBFORM', assunto: 'Get a quote', criadoMs: -3 * 864e5 });
    lead(1201, { email: 'mkt.sales@topsolid.com' });
    email(++seq, { de: 'Hubspot Landing <mkt.sales@topsolid.com>', assunto: 'Get a quote', lead: 1201, corpo: FORMULARIO });
    await rodar(seq);
    assert.deepStrictEqual(estado.excluidos, []);
    assert.strictEqual(estado.leads[1201].SOURCE_ID, 'WEBFORM', 'o novo quote é preenchido normalmente');
    assert.ok(estado.leads[1200], 'o antigo continua');
});

await t('QUOTE: vindo dos três remetentes de formulário, todos preenchem', async () => {
    config.excluirLeadDesconhecido = true;
    const remetentes = ['TopSolid <no-reply@topsolid.com>', 'Hubspot Landing <mkt.sales@topsolid.com>', 'CadSolid <marketing@cadsolid.pt>'];
    for (const [i, de] of remetentes.entries()) {
        const id = 1300 + i;
        // e-mails de cliente diferentes para não cair na regra de duplicata
        const corpo = FORMULARIO.replace(/vinicius@ds\.ind\.br/g, `cliente${i}@exemplo.com.br`);
        lead(id, { email: 'remetente@x.com' });
        email(++seq, { de, assunto: 'Get a quote', lead: id, corpo });
        await rodar(seq);
        assert.strictEqual(estado.leads[id].SOURCE_ID, 'WEBFORM', `não preencheu vindo de ${de}`);
    }
    assert.deepStrictEqual(estado.excluidos, []);
});

// ---------- assunto desconhecido ----------

await t('SEGURANÇA: assunto desconhecido não apaga lead que já foi preenchido', async () => {
    config.excluirLeadDesconhecido = true;
    lead(900, { email: 'vinicius@ds.ind.br', origem: 'WEBFORM' });
    email(++seq, { de: 'TopSolid <no-reply@topsolid.com>', assunto: 'Assunto que não é de formulário', lead: 900 });
    await rodar(seq);
    assert.deepStrictEqual(estado.excluidos, []);
});

await t('assunto desconhecido de remetente de formulário, lead cru: apagado', async () => {
    config.excluirLeadDesconhecido = true;
    lead(901, { email: 'no-reply@topsolid.com' });
    email(++seq, { de: 'TopSolid <no-reply@topsolid.com>', assunto: 'Assunto que não é de formulário', lead: 901 });
    await rodar(seq);
    assert.deepStrictEqual(estado.excluidos, ['901']);
});

bitrix.close();
console.log(`\n${ok} passaram, ${falhas} falharam`);
process.exit(falhas ? 1 : 0);
