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
    const chave = texto(valor);
    return chave && Object.prototype.hasOwnProperty.call(mapa, chave) ? mapa[chave] : '';
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
 * Lê o lead uma única vez e monta EMAIL e PHONE já com as remoções embutidas.
 *
 * A versão anterior disparava a limpeza do e-mail em uma requisição paralela ao
 * update principal (sem await entre as duas): as duas corriam juntas e, na
 * ordem errada, apagavam o e-mail recém-gravado. Agora é uma requisição só.
 */
async function montarContatos(leadId, dados) {
    // Sem e-mail nem telefone não há o que substituir: evita uma chamada à API.
    if (!dados.email && !dados.phone) return { EMAIL: null, PHONE: null };

    let lead = null;
    try {
        lead = await bitrix.buscarLead(leadId);
    } catch (e) {
        erro(`leitura do lead ${leadId} para substituir e-mail/telefone`, e);
    }

    return {
        EMAIL: montarMultifield('EMAIL', lead && lead.EMAIL, dados.email),
        PHONE: montarMultifield('PHONE', lead && lead.PHONE, dados.phone),
    };
}

/**
 * Texto de "Informações Brutas" publicado no mural do lead.
 */
export function montarResumo(layout, assunto, dados) {
    const linhas = layout.resumo
        .map((campo) => `[b]- ${rotuloDe(layout, campo)}:[/b] ${dados[campo] || ''}`)
        .join('\n');

    return [
        '[b][Mail Parser][/b]',
        '',
        'Informações Brutas:',
        '',
        `[COLOR=#ff0000][Fonte] - ${fonteDe(layout, assunto)}[/COLOR]`,
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
    // Agora vem do campo Country do próprio formulário.
    const pais = idDoPais(dados.country) || config.lead.paisPadrao;
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

// Uma fila por lead. Duas mensagens do mesmo lead chegando juntas fariam as
// duas lerem o EMAIL antigo e cada uma acrescentar o seu — mais um caminho para
// o cartão terminar com vários e-mails.
const filaPorLead = new Map();

/**
 * Atualiza o lead com os dados do formulário e publica o resumo no mural.
 * Execuções para o mesmo lead são serializadas.
 */
export function atualizarLeadComFormulario(leadId, assunto, layout, brutos) {
    if (!leadId) {
        log('atividade sem lead associado (OWNER_ID vazio); nada a atualizar');
        return Promise.resolve();
    }

    const anterior = filaPorLead.get(leadId) || Promise.resolve();
    const atual = anterior
        .catch(() => {})
        .then(() => executarAtualizacao(leadId, assunto, layout, brutos));

    filaPorLead.set(leadId, atual);
    atual.catch(() => {}).then(() => {
        if (filaPorLead.get(leadId) === atual) filaPorLead.delete(leadId);
    });

    return atual;
}

async function executarAtualizacao(leadId, assunto, layout, brutos) {
    const dados = normalizarDados(brutos);
    log('dados extraídos', dados);

    if (!dados.email) {
        // Sem e-mail o Bitrix não consegue vincular as próximas mensagens a este
        // lead — é exatamente assim que nascem cartões duplicados.
        log(`ATENÇÃO: não foi possível extrair o e-mail do lead ${leadId} (assunto: ${assunto})`);
    }

    const contatos = await montarContatos(leadId, dados);
    const fields = montarCamposDoLead(assunto, dados, contatos);

    await bitrix.atualizarLead(leadId, fields);
    log(`lead ${leadId} atualizado`);

    await bitrix.postarNoMural(leadId, montarResumo(layout, assunto, dados));
    await avisarDuplicidade(leadId, dados);
}
