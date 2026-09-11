// Extração de campos do corpo HTML dos e-mails de formulário.
//
// A versão anterior repetia, para cada campo, o par:
//     description.substring(indexOf(inicio), indexOf(fim))
//     .substring(indexOf(':') + N, indexOf('</p>'))
// O `+ N` (1, 2, 3, 8, 9) era um ajuste manual para pular tags e entidades que
// vinham depois dos dois-pontos. Isso torna o parser refém do HTML exato e
// falha em silêncio: `indexOf` devolvendo -1 faz `substring` inverter os
// argumentos e devolver lixo em vez de vazio.
//
// Aqui a extração é uma função só: recorta o trecho, corta no fim do
// parágrafo/item, joga fora tudo antes dos dois-pontos, remove as tags e
// decodifica as entidades. Some o `+ N` e some a falha silenciosa.

const ENTIDADES = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', auml: 'ä',
    eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë',
    iacute: 'í', icirc: 'î', iuml: 'ï',
    oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö',
    uacute: 'ú', ucirc: 'û', uuml: 'ü',
    ccedil: 'ç', ntilde: 'ñ',
    Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Atilde: 'Ã',
    Eacute: 'É', Ecirc: 'Ê', Iacute: 'Í',
    Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ',
    Uacute: 'Ú', Ccedil: 'Ç',
};

function decodificarEntidades(texto) {
    return texto
        .replace(/&#x([0-9a-f]+);/gi, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(Number(dec)))
        .replace(/&([a-zA-Z]+);/g, (m, nome) => {
            if (Object.prototype.hasOwnProperty.call(ENTIDADES, nome)) return ENTIDADES[nome];
            const minusculo = nome.toLowerCase();
            return Object.prototype.hasOwnProperty.call(ENTIDADES, minusculo) ? ENTIDADES[minusculo] : m;
        });
}

/**
 * Transforma um pedaço de HTML em texto limpo.
 */
export function limparHtml(trecho) {
    if (!trecho) return '';
    const semTags = String(trecho)
        .replace(/<o:p>\s*<\/o:p>/gi, '')   // lixo que o Outlook injeta
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<[^>]*>/g, ' ');
    return decodificarEntidades(semTags).replace(/\s+/g, ' ').trim();
}

/**
 * Procura o primeiro dos marcadores em `texto` a partir de `inicio`.
 * Aceita string ou lista de alternativas e devolve o que aparecer antes.
 */
function acharMarcador(texto, marcadores, inicio = 0) {
    if (!marcadores) return { index: -1, marcador: '' };
    const lista = Array.isArray(marcadores) ? marcadores : [marcadores];

    let melhor = { index: -1, marcador: '' };
    for (const marcador of lista) {
        if (!marcador) continue;
        const pos = texto.indexOf(marcador, inicio);
        if (pos === -1) continue;
        if (melhor.index === -1 || pos < melhor.index) melhor = { index: pos, marcador };
    }
    return melhor;
}

const REGEX_EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;

function extrairEmail(trechoHtml, valorLimpo) {
    // O e-mail costuma vir dentro de <a href="mailto:...">.
    const mailto = trechoHtml.match(/mailto:([^"'>\s]+)/i);
    if (mailto) return decodificarEntidades(mailto[1]);
    if (REGEX_EMAIL.test(valorLimpo)) return valorLimpo;
    const solto = trechoHtml.replace(/<[^>]*>/g, ' ').match(REGEX_EMAIL);
    return solto ? solto[0] : valorLimpo;
}

/**
 * Extrai um campo do corpo do e-mail.
 *
 * @param {string} html         corpo do e-mail
 * @param {object} spec
 * @param {string|string[]} spec.de    marcador (rótulo) onde o campo começa
 * @param {string|string[]} spec.ate   marcador do próximo campo; opcional
 * @param {string} spec.tipo           'email' liga a busca por mailto/regex
 * @param {string[]} fim               tags que encerram o valor (</p>, </li>, ...)
 * @returns {string} valor limpo, ou '' se o campo não existir no e-mail
 */
export function extrairCampo(html, spec, fim = ['</p>']) {
    if (!html || !spec || !spec.de) return '';

    const inicio = acharMarcador(html, spec.de, 0);
    if (inicio.index === -1) return '';

    // O marcador de fim é procurado DEPOIS do de início. A versão anterior
    // procurava desde o começo do e-mail, então um rótulo que aparecesse antes
    // (ou uma palavra contida em outra) invertia o recorte silenciosamente.
    const apos = inicio.index + inicio.marcador.length;
    const limite = acharMarcador(html, spec.ate, apos);

    let trecho = html.slice(inicio.index, limite.index === -1 ? html.length : limite.index);

    // Corta no fechamento do parágrafo/item para não arrastar o resto do e-mail
    // quando o marcador de fim não existe naquele layout.
    const encerra = acharMarcador(trecho, spec.fim || fim, 0);
    if (encerra.index !== -1) trecho = trecho.slice(0, encerra.index);

    const doisPontos = trecho.indexOf(':');
    const conteudo = doisPontos === -1 ? trecho : trecho.slice(doisPontos + 1);
    const valor = limparHtml(conteudo);

    return spec.tipo === 'email' ? extrairEmail(trecho, valor) : valor;
}

/**
 * Aplica um mapa de specs de uma vez.
 */
export function extrairCampos(html, campos, fim) {
    const dados = {};
    for (const nome of Object.keys(campos)) {
        dados[nome] = extrairCampo(html, campos[nome], fim);
    }
    return dados;
}
