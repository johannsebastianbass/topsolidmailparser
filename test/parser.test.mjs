import assert from 'assert';
import { extrairCampos, limparHtml } from '../src/htmlParser.js';
import { acharLayout, idDoPais, idDaLista, MAPA_INDUSTRY_INTEREST, MAPA_FIELD_OF_APPLICATION } from '../src/layouts.js';
import { ehRespostaDeEmail, remetenteAceito } from '../src/topSolid.js';
import { normalizarDados, montarResumo, normalizarTelefone, montarMultifield, montarCamposDoLead } from '../src/lead.js';

let ok = 0, falhas = 0;
function t(nome, fn) {
    try { fn(); ok++; console.log('  ok  -', nome); }
    catch (e) { falhas++; console.log('  FALHA -', nome, '\n      ', e.message); }
}

// ---------- Contact Request ----------
const contactRequest = `
<div><p><strong>E-mail:</strong> <a href="mailto:joao.silva@empresa.com.br">joao.silva@empresa.com.br</a></p>
<p><strong>Last Name:</strong>&nbsp;Silva<o:p></o:p></p>
<p><strong>First Name:</strong> Jo&atilde;o</p>
<p><strong>Field of activity:</strong> Industrie</p>
<p><strong>Company:</strong> Metal &amp; Cia</p>
<p><strong>Zip Code:</strong> 89.220-100</p>
<p><strong>Country:</strong>&nbsp;Brazil</p>
<p><strong>Industry Interest:</strong>&nbsp;<span>Precision Manufacturing, Woodworking</span></p>
<p><strong>Field of application:</strong> Metalworking</p>
<p><strong>Phone:</strong> (47) 99999-8888</p>
<p><strong>Message:</strong>&nbsp;Gostaria de 50% de desconto no or&ccedil;amento</p>
<p>TOPSOLID SAS - 7 rue du Bois Sauvage</p></div>`;

t('Contact Request: layout reconhecido', () => {
    assert.strictEqual(acharLayout('Contact Request').id, 'contact-request');
});

t('Contact Request: todos os campos', () => {
    const l = acharLayout('Contact Request');
    const d = normalizarDados(extrairCampos(contactRequest, l.campos, l.fim));
    assert.strictEqual(d.email, 'joao.silva@empresa.com.br');
    assert.strictEqual(d.lastName, 'Silva');
    assert.strictEqual(d.firstName, 'João');
    assert.strictEqual(d.fieldOfActivity, 'Industrie');
    assert.strictEqual(d.company, 'Metal & Cia');
    assert.strictEqual(d.zipCode, '89220100');            // antes sobrava o '.' ou o '-'
    assert.strictEqual(d.country, 'Brazil');
    assert.strictEqual(d.industryInterest, 'Precision Manufacturing');
    assert.strictEqual(d.fieldOfApplication, 'Metalworking');
    assert.strictEqual(d.phone, '+5547999998888');
    assert.strictEqual(d.message, 'Gostaria de 50% de desconto no orçamento');
});

t('Contact Request: campo ausente vira vazio (nao lixo)', () => {
    const l = acharLayout('Contact Request');
    const d = extrairCampos('<p>e-mail sem nenhum dos rotulos</p>', l.campos, l.fim);
    Object.keys(d).forEach((k) => assert.strictEqual(d[k], '', `campo ${k} deveria ser vazio, veio "${d[k]}"`));
});

// ---------- Get a quote / Demo request ----------
const cotacao = `<p>E-mail: <a href="mailto:ana@fab.com">ana@fab.com</a></p>
<p>Last Name:&nbsp;Souza</p><p>First Name: Ana</p><p>Company: Fab Ltda</p>
<p>Zip Code: 01310-100</p><p>Country:&nbsp;Brazil</p>
<p>Industry Interest:&nbsp;Steel Industry</p><p>Phone: 11 3333-4444</p>
<p>Message:&nbsp;Preciso de proposta</p><p>TOPSOLID GROUP</p>`;

t('Get a quote e Demo request usam o mesmo parsing', () => {
    for (const assunto of ['Get a quote', 'Demo request']) {
        const l = acharLayout(assunto);
        const d = normalizarDados(extrairCampos(cotacao, l.campos, l.fim));
        assert.strictEqual(d.email, 'ana@fab.com', assunto);
        assert.strictEqual(d.firstName, 'Ana', assunto);
        assert.strictEqual(d.industryInterest, 'Steel Industry', assunto);
        assert.strictEqual(d.message, 'Preciso de proposta', assunto);
        assert.strictEqual(d.phone, '+551133334444', assunto);
    }
});

// ---------- Download alert ----------
const download = `<p>E-mail: <a href="mailto:cli@x.de">cli@x.de</a></p><p>Last Name: Muller</p>
<p>First Name: Hans</p><p>Company: Werk GmbH</p><p>Zip Code: 10115</p>
<p>Country:&nbsp;Germany</p><p>Product Interest:&nbsp;<b>TopSolid Design</b></p>
<p>Phone:&nbsp;+49 30 1234567</p><p>TOPSOLID SAS</p>`;

t('Download alert: campos e fonte real do assunto', () => {
    const assunto = 'Download alert: Design Brochure from our website';
    const l = acharLayout(assunto);
    const d = normalizarDados(extrairCampos(download, l.campos, l.fim));
    assert.strictEqual(d.email, 'cli@x.de');
    assert.strictEqual(d.productInterest, 'TopSolid Design');
    assert.strictEqual(d.phone, '+49301234567');   // internacional: nao leva +55
    const resumo = montarResumo(l, assunto, d);
    assert.ok(resumo.includes('[Fonte] - Download alert: Design Brochure from our website'), resumo);
});

// ---------- [Contact] ----------
const contato = `<ul><li>First Name: Marc</li><li>Last Name: Dupont</li><li>Company: Dupont SA</li>
<li>Zip: 75001</li><li>Street / House Number: Rue de Rivoli 10</li><li>City: Paris</li>
<li>State: IDF</li><li>Country: France</li><li>Phone: +33 1 2345 6789</li>
<li>Email: marc@dupont.fr</li><li>Newsletter: yes</li>
<li>TopSolid Distributor Contact: Revendedor X</li></ul><p>Sincerely, TopSolid</p>`;

t('[Contact]: campos com </li> e distribuidor', () => {
    const l = acharLayout('[Contact] novo formulario');
    const d = normalizarDados(extrairCampos(contato, l.campos, l.fim));
    assert.strictEqual(d.firstName, 'Marc');
    assert.strictEqual(d.city, 'Paris');
    assert.strictEqual(d.state, 'IDF');
    assert.strictEqual(d.email, 'marc@dupont.fr');
    assert.strictEqual(d.distributor, 'Revendedor X');
    assert.strictEqual(d.phone, '+33123456789');
});

t('[Contact]: sem Newsletter e sem Distributor Contact', () => {
    const semExtras = `<ul><li>First Name: Ann</li><li>Last Name: Lee</li><li>Company: L</li>
<li>Zip: 1</li><li>Street / House Number: R</li><li>City: C</li><li>State: S</li>
<li>Country: UK</li><li>Phone: 1</li><li>Email: ann@lee.uk</li></ul><p>If you: nada</p><p>Sincerely</p>`;
    const l = acharLayout('[Contact] x');
    const d = normalizarDados(extrairCampos(semExtras, l.campos, l.fim));
    assert.strictEqual(d.email, 'ann@lee.uk');
});

// ---------- Trial 6 / 7 / Pedido de ----------
const trial7 = `<p><b>Nome:</b>&nbsp;Carlos</p><p><b>Email:</b>&nbsp;<a href="mailto:carlos@ind.com.br">carlos@ind.com.br</a></p>
<p><b>Telefone:</b>&nbsp;(11) 98888-7777</p><p><b>Empresa:</b>&nbsp;Ind&uacute;stria ABC</p>
<p><b>&Aacute;rea de neg&oacute;cio:</b>&nbsp;Usinagem</p><p><b>Coment&aacute;rios:</b>&nbsp;Quero testar</p>
<p>Li e aceito a pol&iacute;tica de privacidade</p>`;

t('Trial 7: area de negocio e empresa', () => {
    const l = acharLayout('Download Trial TopSolid 7 - site');
    const d = normalizarDados(extrairCampos(trial7, l.campos, l.fim));
    assert.strictEqual(d.firstName, 'Carlos');
    assert.strictEqual(d.email, 'carlos@ind.com.br');
    assert.strictEqual(d.phone, '+5511988887777');
    assert.strictEqual(d.company, 'Indústria ABC');
    assert.strictEqual(d.areaNeg, 'Usinagem');
    assert.strictEqual(d.message, 'Quero testar');
});

t('Pedido de: aceita </span> como fim de campo', () => {
    const pedido = `<p><b>Nome:</b>&nbsp;Rita</p><p><b>Email:</b>&nbsp;<a href="mailto:rita@z.com">rita@z.com</a></p>
<span><b>Telefone:</b>&nbsp;4899999-0000</span><span><b>Empresa:</b>&nbsp;Zeta</span>
<p><b>Mensagem:</b>&nbsp;Ol&aacute;</p><p>Li e aceito a pol&iacute;tica</p>`;
    const l = acharLayout('Pedido de informação pelo site');
    assert.strictEqual(l.id, 'pedido-de-informacao');
    const d = normalizarDados(extrairCampos(pedido, l.campos, l.fim));
    assert.strictEqual(d.phone, '+5548999990000');
    assert.strictEqual(d.company, 'Zeta');
    assert.strictEqual(d.message, 'Olá');
});

// ---------- regressoes especificas ----------
t('BUG antigo: assunto desconhecido nao cai mais no ramo "Pedido de"', () => {
    assert.strictEqual(acharLayout('Assunto qualquer de spam'), null);
});

t('BUG antigo: assunto que comeca com "Pedido de" e reconhecido', () => {
    assert.strictEqual(acharLayout('Pedido de informação').id, 'pedido-de-informacao');
});

t('telefone: nao gera "+55" sozinho quando o campo vem vazio', () => {
    assert.strictEqual(normalizarTelefone('', 'Brazil'), '');
    assert.strictEqual(normalizarTelefone(undefined, ''), '');
});

t('telefone: nao duplica DDI ja informado', () => {
    assert.strictEqual(normalizarTelefone('+55 (47) 3333-2222', 'Brazil'), '+554733332222');
    assert.strictEqual(normalizarTelefone('554733332222', 'Brazil'), '+554733332222');
});

t('decodeURI nao derruba mais texto com %', () => {
    const l = acharLayout('Contact Request');
    const html = contactRequest.replace('Metal &amp; Cia', 'Desconto 50% Ltda');
    const d = normalizarDados(extrairCampos(html, l.campos, l.fim));
    assert.strictEqual(d.company, 'Desconto 50% Ltda');
});

t('limparHtml remove <o:p></o:p> e colapsa espacos', () => {
    assert.strictEqual(limparHtml('  a <o:p></o:p>  b\n c '), 'a b c');
});

t('resumo do mural mantem o formato BBCode', () => {
    const l = acharLayout('Contact Request');
    const d = normalizarDados(extrairCampos(contactRequest, l.campos, l.fim));
    const r = montarResumo(l, 'Contact Request', d);
    assert.ok(r.startsWith('[b][Mail Parser][/b]'), r);
    assert.ok(r.includes('[b]- First Name:[/b] João'), r);
    assert.ok(r.trim().endsWith('[I]Integração[/I]'), r);
});

// ---------- campos multiplos (EMAIL/PHONE) — causa dos e-mails acumulados ----------

t('EMAIL: apaga TODOS os valores atuais, nao so o primeiro', () => {
    const atuais = [
        { ID: '1', TYPE_ID: 'EMAIL', VALUE_TYPE: 'WORK', VALUE: 'noreply@site.com' },
        { ID: '2', TYPE_ID: 'EMAIL', VALUE_TYPE: 'WORK', VALUE: 'sobra@antigo.com' },
    ];
    const r = montarMultifield('EMAIL', atuais, 'novo@cliente.com');
    assert.strictEqual(r.length, 3, JSON.stringify(r));
    assert.deepStrictEqual(r.filter((e) => e.VALUE === '').map((e) => e.ID), ['1', '2']);
    assert.strictEqual(r[r.length - 1].VALUE, 'novo@cliente.com');
});

t('REGRESSAO: remocao leva TYPE_ID (sem ele o Bitrix ignora em silencio)', () => {
    const r = montarMultifield('EMAIL', [{ ID: '9', VALUE: 'x@y.com' }], 'novo@cliente.com');
    const remocao = r.find((e) => e.VALUE === '');
    assert.strictEqual(remocao.TYPE_ID, 'EMAIL', JSON.stringify(remocao));
    assert.ok(remocao.ID, 'remocao precisa do ID');
});

t('entrada nova nao leva ID (senao o Bitrix trata como edicao)', () => {
    const r = montarMultifield('EMAIL', [], 'novo@cliente.com');
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].ID, undefined);
    assert.strictEqual(r[0].TYPE_ID, 'EMAIL');
});

t('valor ja correto: nao reenvia o campo (idempotente)', () => {
    const atuais = [{ ID: '1', TYPE_ID: 'EMAIL', VALUE: 'novo@cliente.com' }];
    assert.strictEqual(montarMultifield('EMAIL', atuais, 'novo@cliente.com'), null);
});

t('sem valor novo: nao apaga o contato existente', () => {
    const atuais = [{ ID: '1', TYPE_ID: 'EMAIL', VALUE: 'algum@cliente.com' }];
    assert.strictEqual(montarMultifield('EMAIL', atuais, ''), null);
});

t('PHONE segue a mesma regra', () => {
    const r = montarMultifield('PHONE', [{ ID: '5', VALUE: '+551199999999' }], '+554733332222');
    assert.strictEqual(r.filter((e) => e.VALUE === '')[0].TYPE_ID, 'PHONE');
    assert.strictEqual(r[r.length - 1].VALUE, '+554733332222');
});

// ---------- encaminhamento x resposta (assuntos reais da base migrada) ----------

t('REGRESSAO: encaminhamento "FW:" e formulario legitimo, nao pode ser ignorado', () => {
    // 52 leads na base vieram de assuntos assim; nenhum de "RE:".
    for (const assunto of [
        'FW: Website CadSolid - Download Trial TopSolid 7',
        'FW: Formulario Website Wood CadSolid - Pedido de informacao',
        'FW: Formulario Website - Pedido de informacao',
    ]) {
        assert.strictEqual(ehRespostaDeEmail(assunto), false, assunto);
        assert.ok(acharLayout(assunto), `deveria achar layout para: ${assunto}`);
    }
});

t('FW de Trial 7 cai no layout certo', () => {
    assert.strictEqual(acharLayout('FW: Website CadSolid - Download Trial TopSolid 7').id, 'trial-7');
});

t('FW de Pedido de informacao cai no layout certo', () => {
    assert.strictEqual(acharLayout('FW: Formulario Website - Pedido de informacao').id, 'pedido-de-informacao');
});

t('resposta "RE:"/"RES:" continua bloqueada', () => {
    for (const assunto of ['RE: Contact Request', 'Re: proposta', 'RES: orcamento']) {
        assert.strictEqual(ehRespostaDeEmail(assunto), true, assunto);
    }
});

t('"RE:" no meio de uma palavra nao conta como resposta', () => {
    assert.strictEqual(ehRespostaDeEmail('CORE: novidades'), false);
});

t('assuntos reais de outros formularios seguem reconhecidos', () => {
    const casos = [
        ['Contact Request', 'contact-request'],
        ['Get a quote', 'get-a-quote'],
        ['Demo request', 'demo-request'],
        ['Download alert: Wood Brochure from our website', 'download-alert'],
        ['[Contact] User vinicius@unesp.br confirmed registration on site TopSolid', 'contact-colchete'],
        ['NOVO: Pedido de orcamento alternativo', 'pedido-de-informacao'],
    ];
    for (const [assunto, esperado] of casos) {
        const l = acharLayout(assunto);
        assert.ok(l, `sem layout: ${assunto}`);
        assert.strictEqual(l.id, esperado, assunto);
    }
});

// ---------- filtro de remetente ----------
// Configurado via REMETENTES_PERMITIDOS; o .env do projeto usa no-reply@topsolid.com.

t('remetentes permitidos passam (com nome e sinais de menor/maior)', () => {
    assert.strictEqual(remetenteAceito('TopSolid <no-reply@topsolid.com>'), true);
    assert.strictEqual(remetenteAceito('no-reply@topsolid.com'), true);
    assert.strictEqual(remetenteAceito('NO-REPLY@TOPSOLID.COM'), true);
    // mkt.sales encaminha os formularios da Franca para o marketing do Brasil
    assert.strictEqual(remetenteAceito('TopSolid Marketing <mkt.sales@topsolid.com>'), true);
    assert.strictEqual(remetenteAceito('MKT.Sales@TopSolid.com'), true);
    // CadSolid (distribuidor em Portugal) tambem encaminha formularios
    assert.strictEqual(remetenteAceito('CadSolid <marketing@cadsolid.pt>'), true);
});

t('assuntos reais encaminhados pelo CadSolid caem nos layouts certos', () => {
    const casos = [
        ['FW: Website CadSolid - Download Trial TopSolid 7', 'trial-7'],
        ['FW: Website Wood CadSolid - Download Trial TopSolid 6', 'trial-6'],
        ['FW: Website CadSolid - Download Trial TopSolid 6', 'trial-6'],
        ['FW: Formulario Website Wood CadSolid - Pedido de informacao', 'pedido-de-informacao'],
    ];
    for (const [assunto, esperado] of casos) {
        const l = acharLayout(assunto);
        assert.ok(l, `sem layout: ${assunto}`);
        assert.strictEqual(l.id, esperado, assunto);
    }
});

t('remetente fora da lista e barrado', () => {
    assert.strictEqual(remetenteAceito('newsletter@fornecedor.com.br'), false);
    assert.strictEqual(remetenteAceito('noreply@transfernow.net'), false);
    assert.strictEqual(remetenteAceito(''), false);
});

// ---------- payload do lead ----------

t('REGRESSAO: campo extraido vazio nao vai no payload (nao apaga o que existe)', () => {
    const vazios = normalizarDados({});
    const f = montarCamposDoLead('Contact Request', vazios, { EMAIL: null, PHONE: null });
    for (const campo of ['TITLE', 'NAME', 'LAST_NAME', 'COMPANY_TITLE', 'COMMENTS']) {
        assert.ok(!(campo in f), `${campo} nao deveria ser enviado: ${JSON.stringify(f[campo])}`);
    }
    assert.strictEqual(f.ASSIGNED_BY_ID, '105');
    assert.strictEqual(f.SOURCE_ID, 'WEBFORM');
});

t('campos preenchidos continuam indo normalmente', () => {
    const l = acharLayout('Contact Request');
    const d = normalizarDados(extrairCampos(contactRequest, l.campos, l.fim));
    const f = montarCamposDoLead('Contact Request', d, { EMAIL: null, PHONE: null });
    assert.strictEqual(f.NAME, 'João');
    assert.strictEqual(f.LAST_NAME, 'Silva');
    assert.strictEqual(f.TITLE, 'Metal & Cia');
    assert.strictEqual(f.COMPANY_TITLE, 'Metal & Cia');
    assert.strictEqual(f.COMMENTS, 'Gostaria de 50% de desconto no orçamento');
});

t('pais vem do formulario; sem pais usa o padrao', () => {
    const comPais = montarCamposDoLead('x', normalizarDados({ country: 'Germany' }), { EMAIL: null, PHONE: null });
    assert.strictEqual(comPais['UF_CRM_1677508604'], '913');   // sempre string
    const semPais = montarCamposDoLead('x', normalizarDados({}), { EMAIL: null, PHONE: null });
    assert.strictEqual(semPais['UF_CRM_1677508604'], '919');
});

// ---------- listas do Bitrix: valores reais que os formulários mandam ----------

t('país: código ISO e formato composto do formulário [Contact]', () => {
    assert.strictEqual(idDoPais('BR'), 919);                  // 12 dos 19 leads de 09/2026
    assert.strictEqual(idDoPais('Brasil -/- Brazil'), 919);   // os outros 7
    assert.strictEqual(idDoPais('FR'), 930);
    assert.strictEqual(idDoPais('UK'), 950);
});

t('país: valor não reconhecido NÃO vira um chute', () => {
    assert.strictEqual(idDoPais('XX'), '');
    assert.strictEqual(idDoPais('Freedonia'), '');
});

t('REGRESSAO: país informado e não reconhecido não é gravado como Brasil', () => {
    const f = montarCamposDoLead('x', normalizarDados({ country: 'Freedonia' }), { EMAIL: null, PHONE: null });
    assert.ok(!('UF_CRM_1677508604' in f), `não pode chutar Brasil: ${f.UF_CRM_1677508604}`);
    const semCampo = montarCamposDoLead('x', normalizarDados({}), { EMAIL: null, PHONE: null });
    assert.strictEqual(semCampo.UF_CRM_1677508604, '919', 'sem o campo, o padrão continua valendo');
});

t('REGRESSAO: lista ignora maiúscula — "Steel industry" do site', () => {
    assert.strictEqual(idDaLista(MAPA_INDUSTRY_INTEREST, 'Steel industry'), 1007);
});

t('lista: variantes em francês que o site manda', () => {
    assert.strictEqual(idDaLista(MAPA_FIELD_OF_APPLICATION, "Bureau d'étude (CAO)"), 1073);
    assert.strictEqual(idDaLista(MAPA_FIELD_OF_APPLICATION, 'Bureau d’étude (CAO)'), 1073, 'apóstrofo tipográfico');
    assert.strictEqual(idDaLista(MAPA_FIELD_OF_APPLICATION, 'Industrie du bois'), 1077);
});

t('lista: "Tooling" continua sem correspondência (não existe opção no Bitrix)', () => {
    assert.strictEqual(idDaLista(MAPA_INDUSTRY_INTEREST, 'Tooling'), '');
});

console.log(`\n${ok} passaram, ${falhas} falharam`);
process.exit(falhas ? 1 : 0);
