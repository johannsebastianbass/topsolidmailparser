// Atualização do lead no Bitrix a partir dos dados extraídos do e-mail.

import config from './config.js';
import * as bitrix from './bitrix.js';
import { log, erro } from './logger.js';
import {
    rotuloDe,
    fonteDe,
    MAPA_FIELD_OF_ACTIVITY,
    MAPA_INDUSTRY_INTEREST,
    MAPA_FIELD_OF_APPLICATION,
    idDoPais,
    idDaLista,
} from './layouts.js';

const texto = (valor) => (valor === undefined || valor === null ? '' : String(valor).trim());

function limparCep(valor) {
    // A versão anterior usava replace('-', '') sem /g e limpava só a primeira
    // ocorrência de cada separador.
    return texto(valor).replace(/[.\-\s]/g, '');
}

function ehBrasil(pais) {
    // Formulários em português não têm campo país; assumimos Brasil.
    if (!texto(pais)) return true;
    return /bra[sz]il/i.test(pais);
}

/**
 * Normaliza o telefone para o formato E.164 que o Bitrix espera.
 * A regra do '+55' fixo quebrava lead internacional (virava +55<número
 * estrangeiro>) e criava um telefone "+55" vazio quando o formulário não tinha
 * o campo.
 */
export function normalizarTelefone(bruto, pais) {
    const original = texto(bruto);
    const digitos = original.replace(/\D/g, '');
    if (!digitos) return '';

    if (original.charAt(0) === '+') return `+${digitos}`;   // já veio com DDI
    if (digitos.length >= 12) return `+${digitos}`;         // tamanho só compatível com DDI
    if (ehBrasil(pais)) return `+55${digitos}`;
    return digitos;                                          // país estrangeiro sem DDI: não inventa um
}

function indiceDe(mapa, valor) {
    return idDaLista(mapa, valor);
}

/**
 * Monta um campo múltiplo (EMAIL/PHONE) substituindo de fato os valores atuais.
 *
 * Duas regras do Bitrix que a versão anterior não respeitava:
 *
 *  - Valor SEM ID é tratado como entrada NOVA: os valores existentes continuam
 *    lá. Por isso o cartão acumulava vários e-mails.
 *  - Para apagar um valor é preciso mandar ID + TYPE_ID + VALUE vazio. Sem o
 *    TYPE_ID o Bitrix responde sucesso e simplesmente não apaga nada — falha
 *    silenciosa. O código anterior mandava só ID e VALUE.
 */
export function montarMultifield(tipo, atuais, valorNovo) {
    // Sem valor novo não mexemos no campo: apagar o que existe deixaria o lead
    // sem contato e faria o Bitrix criar outro lead na próxima mensagem.
    if (!valorNovo) return null;

    const entradas = [];
    for (const item of atuais || []) {
        if (!item || !item.ID) continue;
        if (String(item.VALUE || '') === valorNovo) return null;   // já está correto
        entradas.push({
            ID: item.ID,
            TYPE_ID: item.TYPE_ID || tipo,
            VALUE_TYPE: item.VALUE_TYPE || 'WORK',
            VALUE: '',
        });
    }

    entradas.push({ TYPE_ID: tipo, VALUE_TYPE: 'WORK', VALUE: valorNovo });
    return entradas;
}

/**
 * Texto de "Informações Brutas" publicado no mural do lead.
 */
export function montarResumo(layout, assunto, dados, dePara) {
    const linhas = layout.resumo
        .map((campo) => `[b]- ${rotuloDe(layout, campo)}:[/b] ${dados[campo] || ''}`)
        .join('\n');

    // DE/PARA do e-mail original: por qual canal o formulário chegou.
    const origem = dePara
        ? [`[b]- Recebido de:[/b] ${dePara.de || ''}`, `[b]- Para:[/b] ${dePara.para || ''}`, '']
        : [];

    return [
        '[b][Mail Parser][/b]',
        '',
        'Informações Brutas:',
        '',
        `[COLOR=#ff0000][Fonte] - ${fonteDe(layout, assunto)}[/COLOR]`,
        ...origem,
        linhas,
        '',
        '[I]Integração[/I]',
    ].join('\n');
}

/**
 * Normaliza os dados crus extraídos do e-mail.
 */
export function normalizarDados(brutos) {
    const dados = {
        email: texto(brutos.email),
        firstName: texto(brutos.firstName),
        lastName: texto(brutos.lastName),
        company: texto(brutos.company),
        zipCode: limparCep(brutos.zipCode),
        country: texto(brutos.country),
        message: texto(brutos.message),
        fieldOfActivity: texto(brutos.fieldOfActivity),
        fieldOfApplication: texto(brutos.fieldOfApplication),
        productInterest: texto(brutos.productInterest),
        street: texto(brutos.street),
        city: texto(brutos.city),
        state: texto(brutos.state),
        distributor: texto(brutos.distributor),
        areaNeg: texto(brutos.areaNeg),
    };

    // Industry Interest pode vir como lista; o Bitrix só aceita o primeiro.
    const interesse = texto(brutos.industryInterest);
    const virgula = interesse.indexOf(',');
    dados.industryInterest = virgula === -1 ? interesse : interesse.substring(0, virgula);

    dados.phone = normalizarTelefone(brutos.phone, dados.country);

    return dados;
}

export function montarCamposDoLead(assunto, dados, contatos) {
    const c = config.campos;

    const fields = {
        ASSIGNED_BY_ID: config.lead.assignedById,
        SOURCE_ID: config.lead.sourceId,
    };

    // Campo extraído vazio NÃO vai no payload: mandar '' apagaria o que o
    // Bitrix já tinha preenchido a partir do e-mail. A versão anterior mandava
    // tudo, e um parsing parcial zerava nome, empresa e comentário do lead.
    const sePreenchido = (campo, valor) => {
        if (valor) fields[campo] = valor;
    };

    sePreenchido('TITLE', dados.company || dados.firstName);
    sePreenchido('NAME', dados.firstName);
    sePreenchido('LAST_NAME', dados.lastName);
    sePreenchido('COMPANY_TITLE', dados.company);
    sePreenchido('SOURCE_DESCRIPTION', assunto);
    sePreenchido('COMMENTS', dados.message);
    sePreenchido(c.assunto, assunto);
    sePreenchido(c.cep, dados.zipCode);

    // País: antes era o ID fixo '1625' (do portal antigo, inexistente aqui).
    // Agora vem do campo Country do próprio formulário. O padrão (Brasil) só é
    // usado quando o formulário NÃO tem o campo — os formulários em português
    // não têm. Se o campo veio e não foi reconhecido, fica vazio: gravar Brasil
    // num lead da França seria pior do que não gravar nada. O valor original
    // fica no resumo da linha do tempo de qualquer forma.
    const pais = dados.country ? idDoPais(dados.country) : config.lead.paisPadrao;
    if (pais) fields[c.pais] = String(pais);   // o ID do mapa é número, o padrão é string

    // null = campo já está correto (ou não temos valor); não mandamos para não
    // criar entrada duplicada nem apagar o contato existente.
    if (contatos.EMAIL) fields.EMAIL = contatos.EMAIL;
    if (contatos.PHONE) fields.PHONE = contatos.PHONE;

    // Campos de lista só entram quando o valor foi reconhecido — antes iam como
    // [undefined] e o Bitrix recebia lixo.
    const atividade = indiceDe(MAPA_FIELD_OF_ACTIVITY, dados.fieldOfActivity);
    if (atividade) fields[c.fieldOfActivity] = [atividade];

    const interesse = indiceDe(MAPA_INDUSTRY_INTEREST, dados.industryInterest);
    if (interesse) fields[c.industryInterest] = [interesse];

    const aplicacao = indiceDe(MAPA_FIELD_OF_APPLICATION, dados.fieldOfApplication);
    if (aplicacao) fields[c.fieldOfApplication] = aplicacao;

    return fields;
}

/**
 * Avisa nos dois cards quando já existe outro lead com o mesmo e-mail.
 */
async function avisarDuplicidade(leadId, dados) {
    if (!dados.email) return;

    let resultado;
    try {
        resultado = await bitrix.listarLeads({ EMAIL: dados.email, '!ID': leadId });
    } catch (e) {
        erro('busca por leads duplicados', e);
        return;
    }

    // A versão anterior ignorava o alerta quando total era exatamente 50,
    // porque o filtro era uma string JSON montada à mão e podia não ser
    // aplicado — 50 era o tamanho da página. Com o filtro como objeto, `total`
    // é a contagem real e a exceção não faz mais sentido.
    if (resultado.total < 1 || !resultado.itens.length) return;

    const anterior = resultado.itens[0];
    const dominio = config.bitrix.dominio;
    log(`lead duplicado encontrado: ${anterior.ID}`);

    await Promise.all([
        // No card antigo: houve uma nova conversão.
        bitrix.postarNoMural(
            anterior.ID,
            `[b]Mail Parser[/b]\n\n[b]- Mensagem:[/b] Houve uma nova conversão para este e-mail '[U]${dados.email}[/U]'\n[b]Card existente:[/b] [URL=${dominio}/crm/lead/details/${leadId}/]${dados.company || dados.firstName}[/URL]\n\n[I]Integração[/I]`
        ),
        // No card novo: já existe um card para este e-mail.
        bitrix.postarNoMural(
            leadId,
            `[b]Mail Parser[/b]\n\n[b]- Mensagem:[/b] Já existe um card criado para este e-mail '[U]${dados.email}[/U]'\n[b]Card existente:[/b] [URL=${dominio}/crm/lead/details/${anterior.ID}/]${anterior.TITLE}[/URL]\n\n[I]Integração[/I]`
        ),
    ]);
}

// Filas por chave: execuções com a mesma chave rodam uma de cada vez.
const filas = new Map();

/**
 * Executa `fn` depois de todas as execuções anteriores com a mesma `chave`.
 *
 * Serve para dois casos reais:
 *  - por lead: duas mensagens do mesmo lead chegando juntas leriam o EMAIL
 *    antigo e cada uma acrescentaria o seu;
 *  - por e-mail do cliente: o Hubspot às vezes manda a mesma notificação de
 *    formulário duas vezes, com 1 segundo de diferença, gerando DOIS leads
 *    (visto em 22/09: leads 31597 e 31598). Sem serializar pelo e-mail, a
 *    segunda checaria duplicidade antes de a primeira terminar de gravar.
 */
export function comTrava(chave, fn) {
    const anterior = filas.get(chave) || Promise.resolve();
    const atual = anterior.catch(() => {}).then(fn);

    filas.set(chave, atual);
    atual.catch(() => {}).then(() => {
        if (filas.get(chave) === atual) filas.delete(chave);
    });

    return atual;
}

// Mesma pessoa, mesmo formulário, dentro desta janela = a mesma submissão
// chegando repetida, não uma nova conversão.
const JANELA_SUBMISSAO_REPETIDA_MS = 30 * 60 * 1000;

/**
 * Procura um lead que a integração já preencheu para a MESMA submissão:
 * mesmo e-mail, mesmo assunto, criado há pouco. Devolve o lead ou null.
 *
 * A comparação de data é feita aqui, não no filtro do Bitrix, para não
 * depender de como ele interpreta fuso horário.
 */
export async function acharSubmissaoAnterior(leadId, email, assunto, agora = Date.now()) {
    if (!email || !assunto) return null;

    let resultado;
    try {
        const filtro = { EMAIL: email };
        if (leadId) filtro['!ID'] = leadId;
        resultado = await bitrix.listarLeads(
            filtro,
            ['ID', 'TITLE', 'SOURCE_ID', 'SOURCE_DESCRIPTION', 'DATE_CREATE'],
            { ID: 'desc' }
        );
    } catch (e) {
        erro('busca por submissão repetida', e);
        return null;
    }

    return resultado.itens.find((l) => ehMesmaSubmissao(l, assunto, agora)) || null;
}

/** Exportada para teste. */
export function ehMesmaSubmissao(lead, assunto, agora = Date.now()) {
    if (!lead || String(lead.SOURCE_DESCRIPTION || '').trim() !== String(assunto).trim()) return false;
    const criado = Date.parse(lead.DATE_CREATE);
    return Number.isFinite(criado) && agora - criado >= 0 && agora - criado <= JANELA_SUBMISSAO_REPETIDA_MS;
}

/**
 * Submissão repetida: registra no cartão original que o formulário chegou de
 * novo — com os dados, para que nada se perca se a pessoa tiver corrigido
 * alguma informação.
 */
export function registrarSubmissaoRepetida(anteriorId, layout, assunto, brutos, dePara) {
    const dados = normalizarDados(brutos);
    const texto = montarResumo(layout, assunto, dados, dePara)
        .replace('Informações Brutas:', 'O mesmo formulário chegou novamente. Informações recebidas:');
    return bitrix.postarNoMural(anteriorId, texto);
}

/**
 * Marca como duplicata o lead que o Bitrix criou para uma submissão repetida.
 *
 * NÃO apaga: apagar faz a sincronização reimportar o e-mail e criar outro lead.
 * Em vez disso:
 *  - tira os e-mails e telefones do cartão. Senão ele fica com o endereço do
 *    canal (mkt.sales@, no-reply@) e o Bitrix passa a anexar NELE todos os
 *    formulários seguintes desse canal — o mesmo mecanismo que empilhou 380
 *    devoluções num lead só;
 *  - muda o status para "Desqualificado" (JUNK), tirando-o do funil;
 *  - comenta apontando o cartão que vale.
 */
export async function marcarComoDuplicata(leadId, anteriorId) {
    const lead = await bitrix.buscarLead(leadId);
    if (!lead) return;

    const limpar = (itens, tipo) => (itens || []).filter((i) => i && i.ID)
        .map((i) => ({ ID: i.ID, TYPE_ID: i.TYPE_ID || tipo, VALUE_TYPE: i.VALUE_TYPE || 'WORK', VALUE: '' }));

    const fields = { STATUS_ID: 'JUNK' };
    const emails = limpar(lead.EMAIL, 'EMAIL');
    const fones = limpar(lead.PHONE, 'PHONE');
    if (emails.length) fields.EMAIL = emails;
    if (fones.length) fields.PHONE = fones;

    await bitrix.atualizarLead(leadId, fields);

    const dominio = config.bitrix.dominio;
    await bitrix.postarNoMural(leadId,
        '[b][Mail Parser][/b]\n\nEste cartão é uma DUPLICATA: o mesmo formulário chegou duas vezes.\n'
        + `[b]Cartão que vale:[/b] [URL=${dominio}/crm/lead/details/${anteriorId}/]lead ${anteriorId}[/URL]\n\n`
        + 'Marcado como Desqualificado em vez de excluído — excluir faria a sincronização recriá-lo.\n\n[I]Integração[/I]');
    log(`lead ${leadId} marcado como duplicata do lead ${anteriorId}`);
}

// Tempo máximo entre o e-mail chegar e o lead nascer para considerar que foi a
// SINCRONIZAÇÃO que criou o lead. Nos leads reais o atraso ficou entre 3 e 10
// min. Lead criado bem depois do e-mail foi convertido à mão por alguém que
// avaliou a mensagem — e esse nunca é sobrescrito.
const JANELA_LEAD_AUTOMATICO_MS = 30 * 60 * 1000;

/**
 * O lead foi criado automaticamente pela sincronização da caixa, e ninguém
 * mexeu nele ainda? Só nesse caso a integração sobrescreve os campos.
 */
export function ehLeadAutomaticoIntocado(lead, atividade) {
    if (!lead || lead.SOURCE_ID !== 'EMAIL') return false;
    const criado = Date.parse(lead.DATE_CREATE);
    const chegou = Date.parse((atividade && (atividade.START_TIME || atividade.CREATED)) || '');
    if (!Number.isFinite(criado) || !Number.isFinite(chegou)) return false;
    return Math.abs(criado - chegou) <= JANELA_LEAD_AUTOMATICO_MS;
}

/**
 * Preenche com os dados do formulário o lead que a sincronização criou.
 * Execuções para o mesmo lead são serializadas.
 */
export function atualizarLeadComFormulario(leadId, assunto, layout, brutos, atividade, dePara) {
    if (!leadId) {
        log('atividade sem lead associado (OWNER_ID vazio); nada a atualizar');
        return Promise.resolve();
    }

    return comTrava(`lead:${leadId}`, () => executarAtualizacao(leadId, assunto, layout, brutos, atividade, dePara));
}

async function executarAtualizacao(leadId, assunto, layout, brutos, atividade, dePara) {
    const dados = normalizarDados(brutos);
    log('dados extraídos', dados);

    const lead = await bitrix.buscarLead(leadId);
    if (!lead) {
        log(`lead ${leadId} não existe mais; nada a atualizar`);
        return;
    }

    // Lead criado à mão (ou já trabalhado): não sobrescreve nada. Só deixa os
    // dados do formulário no comentário, para quem estiver cuidando dele.
    if (!ehLeadAutomaticoIntocado(lead, atividade)) {
        log(`lead ${leadId} foi criado à mão ou já trabalhado (origem '${lead.SOURCE_ID}'); campos preservados, dados só no comentário`);
        await bitrix.postarNoMural(leadId, montarResumo(layout, assunto, dados, dePara));
        return;
    }

    if (!dados.email) {
        // Sem e-mail o Bitrix não consegue vincular as próximas mensagens a este
        // lead — é exatamente assim que nascem cartões duplicados.
        log(`ATENÇÃO: não foi possível extrair o e-mail do lead ${leadId} (assunto: ${assunto})`);
    }

    const contatos = {
        EMAIL: montarMultifield('EMAIL', lead.EMAIL, dados.email),
        PHONE: montarMultifield('PHONE', lead.PHONE, dados.phone),
    };
    const fields = montarCamposDoLead(assunto, dados, contatos);

    await bitrix.atualizarLead(leadId, fields);
    log(`lead ${leadId} atualizado`);

    await bitrix.postarNoMural(leadId, montarResumo(layout, assunto, dados, dePara));
    await avisarDuplicidade(leadId, dados);
}

/**
 * Cria o lead quando o e-mail do formulário caiu num CONTATO de canal — o
 * cenário em que a caixa não cria lead sozinha para quem escreve. O e-mail é
 * vinculado ao lead novo, então o DE/PARA original aparece na linha do tempo.
 */
export async function criarLeadDoFormulario(atividade, assunto, layout, brutos, dePara) {
    const dados = normalizarDados(brutos);
    log('dados extraídos', dados);

    if (!dados.email && !dados.phone) {
        log(`formulário sem e-mail nem telefone (atividade ${atividade.ID}); lead não criado`);
        return null;
    }

    const contatos = {
        EMAIL: montarMultifield('EMAIL', [], dados.email),
        PHONE: montarMultifield('PHONE', [], dados.phone),
    };
    const fields = montarCamposDoLead(assunto, dados, contatos);

    const novoId = await bitrix.criarLead(fields);
    log(`lead ${novoId} criado a partir da atividade ${atividade.ID}`);

    await bitrix.vincularAtividade(atividade.ID, novoId);
    await bitrix.postarNoMural(novoId, montarResumo(layout, assunto, dados, dePara));
    await avisarDuplicidade(novoId, dados);
    return novoId;
}
