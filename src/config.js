// Configuração central da integração.
//
// O webhook é uma credencial e por isso NÃO fica no código: vem de variável de
// ambiente ou do arquivo .env (que está no .gitignore). O token antigo chegou a
// ser versionado neste repositório — foi o que motivou essa mudança.

import fs from 'fs';
import { fileURLToPath } from 'url';

/**
 * Leitor de .env mínimo, sem dependência externa. Variáveis já definidas no
 * ambiente têm prioridade sobre o arquivo.
 */
function carregarEnv(caminho) {
    let conteudo;
    try {
        conteudo = fs.readFileSync(caminho, 'utf8');
    } catch (e) {
        if (e.code === 'ENOENT') return;   // sem .env: usa só o ambiente
        throw e;
    }

    for (const linha of conteudo.split(/\r?\n/)) {
        const texto = linha.trim();
        if (!texto || texto.charAt(0) === '#') continue;

        const igual = texto.indexOf('=');
        if (igual === -1) continue;

        const chave = texto.slice(0, igual).trim();
        let valor = texto.slice(igual + 1).trim();
        if (/^".*"$/.test(valor) || /^'.*'$/.test(valor)) valor = valor.slice(1, -1);

        if (process.env[chave] === undefined) process.env[chave] = valor;
    }
}

carregarEnv(fileURLToPath(new URL('../.env', import.meta.url)));

const semBarraFinal = (url) => String(url || '').replace(/\/+$/, '');

// Quem envia/encaminha os formulários para a caixa monitorada. Não é segredo,
// por isso fica aqui e não no .env — assim o servidor só precisa do arquivo
// para as duas credenciais.
const REMETENTES_PADRAO = [
    'no-reply@topsolid.com',    // formulários do site TopSolid (França)
    'mkt.sales@topsolid.com',   // marketing da França, encaminha
    'marketing@cadsolid.pt',    // distribuidor CadSolid, encaminha
];

const webhook = semBarraFinal(process.env.BITRIX_WEBHOOK);

/**
 * O domínio do portal sai do próprio webhook. Eram dois valores para manter em
 * sincronia; na troca de portal, esquecer o segundo geraria links do mural
 * apontando para o CRM antigo.
 */
function dominioDoWebhook(url) {
    try {
        return new URL(url).origin;
    } catch (e) {
        return '';
    }
}

const config = {
    bitrix: {
        webhook,
        dominio: semBarraFinal(process.env.BITRIX_DOMINIO) || dominioDoWebhook(webhook),
        timeoutMs: Number(process.env.BITRIX_TIMEOUT_MS) || 15000,
    },

    // Caixa que recebe os formulários do site. Só e-mails entregues nela viram lead.
    // Aceita mais de uma caixa, separadas por vírgula.
    caixasMonitoradas: String(process.env.CAIXAS_MONITORADAS || process.env.CAIXA_MONITORADA || 'marketing@topsolidbrazil.com')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

    // Lista opcional de remetentes aceitos, separados por vírgula. Casa por
    // trecho, então tanto um endereço quanto um domínio funcionam:
    //   REMETENTES_PERMITIDOS=noreply@topsolid.com,@topsolid.com
    // Vazio = aceita qualquer remetente (comportamento atual).
    remetentesPermitidos: String(process.env.REMETENTES_PERMITIDOS || REMETENTES_PADRAO.join(','))
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),

    lead: {
        // 105 = Fernando Pasquali (f.pasquali@topsolidbrazil.com).
        assignedById: process.env.BITRIX_ASSIGNED_BY_ID || '105',
        sourceId: 'WEBFORM',
        // Usado quando o formulário não traz país (os formulários em português
        // não têm esse campo). 919 = Brazil / Brasil neste portal.
        paisPadrao: process.env.BITRIX_PAIS_PADRAO || '919',
    },

    // Token que o Bitrix mostra ao criar o WEBHOOK DE SAÍDA. Ele vem em todo
    // POST, em auth[application_token], e prova que a chamada veio do seu
    // portal. Sem ele configurado o endpoint aceita qualquer requisição.
    tokenWebhookSaida: String(process.env.BITRIX_APPLICATION_TOKEN || '').trim(),

    // A integração NÃO exclui leads. A antiga BITRIX_EXCLUIR_LEAD_DESCONHECIDO
    // foi removida: apagar o lead faz a sincronização da caixa reimportar o
    // e-mail e recriar o lead (ver src/topSolid.js).

    // Cada devolução/reclamação que chega é registrada aqui — é a lista que o
    // marketing usa para limpar a base de envio.
    arquivoDevolucoes: process.env.ARQUIVO_DEVOLUCOES
        || fileURLToPath(new URL('../devolucoes.csv', import.meta.url)),

    // IDs dos campos customizados do Bitrix. ATENÇÃO: são específicos de cada
    // portal — ao trocar de portal precisam ser reconferidos com
    // `node tools/verificar.mjs`.
    campos: {
        assunto: process.env.UF_ASSUNTO || 'UF_CRM_1693246815488',
        cep: process.env.UF_CEP || 'UF_CRM_1677071244610',
        pais: process.env.UF_PAIS || 'UF_CRM_1677508604',
        fieldOfActivity: process.env.UF_FIELD_OF_ACTIVITY || 'UF_CRM_1677072607',
        industryInterest: process.env.UF_INDUSTRY_INTEREST || 'UF_CRM_1677072633',
        fieldOfApplication: process.env.UF_FIELD_OF_APPLICATION || 'UF_CRM_1677071932',
    },

    // UF_CRM_1677507453 ("Função/Cargo") não é preenchido: é uma lista de
    // cargos e nenhum formulário do site traz esse dado. A versão anterior
    // mandava a string literal 'função' para essa lista.
};

export default config;
