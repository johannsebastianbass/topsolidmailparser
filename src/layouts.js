// Catálogo dos formatos de e-mail que a integração sabe ler.
//
// Antes cada formato era um bloco `else if` de ~40 linhas com o mesmo parsing
// copiado e colado. Aqui cada formato é um objeto: como reconhecê-lo, onde
// começa e termina cada campo, e quais campos entram no resumo do mural.
// Formato novo = mais um objeto nesta lista.

// Rodapé institucional do e-mail — serve de marcador de fim da mensagem.
const ASSINATURAS = ['TOPSOLID SAS', 'TOPSOLID GROUP'];

const ROTULOS_PADRAO = {
    firstName: 'First Name',
    lastName: 'Last Name',
    email: 'E-mail',
    phone: 'Phone',
    company: 'Company',
    zipCode: 'Zip Code',
    country: 'Country',
    fieldOfActivity: 'Field of activity',
    industryInterest: 'Industry Interest',
    fieldOfApplication: 'Field of application',
    productInterest: 'Product Interest',
    street: 'Street / House Number',
    city: 'City',
    state: 'State',
    distributor: 'TopSolid Distributor Contact',
    areaNeg: 'Área de negócio',
    message: 'Message',
};

const ROTULOS_PT = {
    firstName: 'Nome',
    email: 'Email',
    phone: 'Telefone',
    company: 'Empresa',
    areaNeg: 'Área de negócio',
    message: 'Mensagem',
};

// Campos comuns aos formulários "Get a quote" e "Demo request".
const CAMPOS_COTACAO = {
    email: { de: 'E-mail', ate: 'Last Name', tipo: 'email' },
    lastName: { de: 'Last Name', ate: 'First Name' },
    firstName: { de: 'First Name', ate: 'Company' },
    company: { de: 'Company', ate: 'Zip Code' },
    zipCode: { de: 'Zip Code', ate: 'Country' },
    country: { de: 'Country', ate: 'Industry Interest' },
    industryInterest: { de: 'Industry Interest', ate: 'Phone' },
    phone: { de: 'Phone', ate: 'Message' },
    message: { de: 'Message', ate: ASSINATURAS },
};

const RESUMO_COTACAO = ['firstName', 'lastName', 'email', 'phone', 'company', 'zipCode', 'country', 'industryInterest', 'message'];

// Formulários em português (Trial 6/7 e Pedido de informação) usam os rótulos
// dentro de tags, por isso os marcadores começam com '>'.
const CAMPOS_TRIAL = {
    firstName: { de: '>Nome', ate: '>Email' },
    email: { de: '>Email', ate: '>Telefone', tipo: 'email' },
    phone: { de: '>Telefone', ate: '>Empresa' },
    company: { de: '>Empresa', ate: '>Mensagem' },
    message: { de: '>Mensagem', ate: 'Li e aceito a pol' },
};

export const LAYOUTS = [
    {
        id: 'contact-request',
        fonte: 'Contact Request',
        combina: (assunto) => assunto === 'Contact Request',
        fim: ['</p>'],
        campos: {
            email: { de: 'E-mail', ate: 'Last Name', tipo: 'email' },
            lastName: { de: 'Last Name', ate: 'First Name' },
            firstName: { de: 'First Name', ate: 'Field of activity' },
            fieldOfActivity: { de: 'Field of activity', ate: 'Company' },
            company: { de: 'Company', ate: 'Zip Code' },
            zipCode: { de: 'Zip Code', ate: 'Country' },
            country: { de: 'Country', ate: 'Industry Interest' },
            industryInterest: { de: 'Industry Interest', ate: 'Field of application' },
            fieldOfApplication: { de: 'Field of application', ate: 'Phone' },
            phone: { de: 'Phone', ate: 'Message' },
            message: { de: 'Message', ate: ASSINATURAS },
        },
        resumo: ['firstName', 'lastName', 'email', 'phone', 'company', 'zipCode', 'country', 'fieldOfActivity', 'industryInterest', 'fieldOfApplication', 'message'],
    },

    {
        id: 'get-a-quote',
        fonte: 'Get a quote',
        combina: (assunto) => assunto === 'Get a quote',
        fim: ['</p>'],
        campos: CAMPOS_COTACAO,
        resumo: RESUMO_COTACAO,
    },

    {
        id: 'demo-request',
        fonte: 'Demo request',
        combina: (assunto) => assunto === 'Demo request',
        fim: ['</p>'],
        campos: CAMPOS_COTACAO,
        resumo: RESUMO_COTACAO,
    },

    {
        id: 'download-alert',
        // A versão anterior fixava "ShopFloor Flyer" no mural mesmo quando o
        // download era outro; agora a fonte é o assunto real do e-mail.
        fonte: (assunto) => assunto,
        combina: (assunto) => assunto.indexOf('Download alert:') !== -1 || assunto === 'Mold News 2022 Flyer Download',
        fim: ['</p>'],
        campos: {
            email: { de: 'E-mail', ate: 'Last Name', tipo: 'email' },
            lastName: { de: 'Last Name', ate: 'First Name' },
            firstName: { de: 'First Name', ate: 'Company' },
            company: { de: 'Company', ate: 'Zip Code' },
            zipCode: { de: 'Zip Code', ate: 'Country' },
            country: { de: 'Country', ate: 'Product Interest' },
            productInterest: { de: 'Product Interest', ate: 'Phone' },
            phone: { de: 'Phone', ate: ASSINATURAS },
        },
        resumo: ['firstName', 'lastName', 'email', 'phone', 'company', 'zipCode', 'country', 'productInterest'],
    },

    {
        id: 'contact-colchete',
        fonte: '[Contact]',
        combina: (assunto) => assunto.indexOf('[Contact]') !== -1,
        fim: ['</li>'],
        campos: {
            firstName: { de: 'First Name', ate: 'Last Name' },
            lastName: { de: 'Last Name', ate: 'Company' },
            company: { de: 'Company', ate: 'Zip' },
            zipCode: { de: 'Zip', ate: 'Street / House Number' },
            street: { de: 'Street / House Number', ate: 'City' },
            city: { de: 'City', ate: 'State' },
            state: { de: 'State', ate: 'Country' },
            country: { de: 'Country', ate: 'Phone' },
            phone: { de: 'Phone', ate: 'Email' },
            // O campo seguinte ao e-mail varia conforme o formulário; a lista de
            // alternativas substitui o encadeamento de ifs da versão anterior.
            email: { de: 'Email', ate: ['Newsletter', 'Distributor Contact', 'If you'], tipo: 'email' },
            distributor: { de: ['Distributor Contact', 'If you'], ate: 'Sincerely' },
        },
        rotulos: { zipCode: 'Zip', email: 'Email' },
        resumo: ['firstName', 'lastName', 'company', 'zipCode', 'street', 'city', 'state', 'country', 'phone', 'email', 'distributor'],
    },

    {
        id: 'trial-6',
        fonte: 'Download Trial TopSolid 6',
        combina: (assunto) => assunto.indexOf('Download Trial TopSolid 6') !== -1,
        fim: ['</p>'],
        campos: CAMPOS_TRIAL,
        rotulos: ROTULOS_PT,
        resumo: ['firstName', 'email', 'phone', 'company', 'message'],
    },

    {
        id: 'trial-7',
        fonte: 'Download Trial TopSolid 7',
        combina: (assunto) => assunto.indexOf('Download Trial TopSolid 7') !== -1,
        fim: ['</p>'],
        campos: {
            ...CAMPOS_TRIAL,
            // 'rea de' porque "Área" chega codificado como &Aacute;rea.
            company: { de: '>Empresa', ate: 'rea de' },
            areaNeg: { de: 'rea de', ate: 'Coment' },
            message: { de: 'Coment', ate: 'Li e aceito a pol' },
        },
        rotulos: ROTULOS_PT,
        resumo: ['firstName', 'email', 'phone', 'company', 'areaNeg', 'message'],
    },

    {
        id: 'pedido-de-informacao',
        fonte: 'Pedido de informação',
        combina: (assunto) => assunto.indexOf('Pedido de') !== -1,
        // Este formulário às vezes fecha os campos em </span> em vez de </p>.
        fim: ['</p>', '</span>'],
        campos: CAMPOS_TRIAL,
        rotulos: ROTULOS_PT,
        resumo: ['firstName', 'email', 'phone', 'company', 'message'],
    },
];

/**
 * Descobre o layout pelo assunto do e-mail. Devolve null quando nenhum bate.
 */
export function acharLayout(assunto) {
    const texto = String(assunto || '');
    return LAYOUTS.find((layout) => layout.combina(texto)) || null;
}

export function rotuloDe(layout, campo) {
    const proprios = layout.rotulos || {};
    return proprios[campo] || ROTULOS_PADRAO[campo] || campo;
}

export function fonteDe(layout, assunto) {
    return typeof layout.fonte === 'function' ? layout.fonte(assunto) : layout.fonte;
}

// Listas de valores dos campos customizados do Bitrix.
//
// ATENÇÃO: estes IDs são específicos do portal. Foram remapeados para o portal
// crm.topsolidbrazil.com — os anteriores eram do portal antigo e nenhum deles
// existe aqui. Ao trocar de portal de novo, rode `node tools/verificar.mjs`.

// Área de atividade (UF_CRM_1677072607)
export const MAPA_FIELD_OF_ACTIVITY = {
    'Industrie': 1081,          // Indústria
    'Education': 1082,          // Educação
    'Privateardeeply': 1083,    // Particular
    'Particulier': 1083,        // Particular
};

// Segmento (UF_CRM_1677072633)
export const MAPA_INDUSTRY_INTEREST = {
    'Digital Ingineering': 1006,        // Engenharia Digital
    'Precision Manufacturing': 1005,    // Fabricação de precisão
    'Woodworking': 1008,                // Trabalho da madeira
    'Steel Industry': 1007,             // Indústria de aço
};

// Área de Aplicação (UF_CRM_1677071932)
export const MAPA_FIELD_OF_APPLICATION = {
    'Design Department (CAD)': 1073,
    'Mechanics': 1074,                           // Mecânica
    'Mécanique': 1074,
    'Outillage (Mold, Progress)': 1075,          // Ferramental (Molde, Progress)
    'Sheet Metal Working / Boilerwork': 1076,    // Trabalho em chapa / Caldeiraria
    'Woodworking Industry': 1077,                // Indústria madeireira
    'Metalworking': 1078,                        // Metalmecânica
    // Variantes em francês que os formulários mandam de fato (vistas em 09/2026).
    "Bureau d'étude (CAO)": 1073,                 // = Design Department (CAD)
    'Industrie du bois': 1077,                   // = Woodworking Industry
};

// País (UF_CRM_1677508604). Antes era o valor fixo '1625', que não existe neste
// portal — agora vem do campo Country do próprio formulário. Gerado a partir da
// lista do portal, com as duas grafias que ele traz (inglês e espanhol/pt).
export const MAPA_PAIS = {
    "Afghanistan": 911,
    "Afganistán": 911,
    "South Africa": 912,
    "Sudáfrica": 912,
    "Germany": 913,
    "Alemania": 913,
    "Argentina": 914,
    "Australia": 915,
    "Austria": 916,
    "Bangladesh": 917,
    "Bangladés": 917,
    "Belgium": 918,
    "Bélgica": 918,
    "Brazil": 919,
    "Brasil": 919,
    "Canada": 920,
    "Canadá": 920,
    "Chile": 921,
    "China": 922,
    "Colombia": 923,
    "South Korea": 924,
    "Corea del Sur": 924,
    "Cuba": 925,
    "Denmark": 926,
    "Dinamarca": 926,
    "Egypt": 927,
    "Egipto": 927,
    "Spain": 928,
    "España": 928,
    "United States": 929,
    "Estados Unidos": 929,
    "France": 930,
    "Francia": 930,
    "Greece": 931,
    "Grecia": 931,
    "India": 932,
    "Indonesia": 933,
    "Iran": 934,
    "Irán": 934,
    "Ireland": 935,
    "Irlanda": 935,
    "Israel": 936,
    "Italy": 937,
    "Italia": 937,
    "Japan": 938,
    "Japón": 938,
    "Lebanon": 939,
    "Líbano": 939,
    "Mexico": 940,
    "México": 940,
    "Mozambique": 941,
    "Nigeria": 942,
    "Norway": 943,
    "Noruega": 943,
    "New Zealand": 944,
    "Nueva Zelanda": 944,
    "Pakistan": 945,
    "Pakistán": 945,
    "Paraguay": 946,
    "Peru": 947,
    "Perú": 947,
    "Poland": 948,
    "Polonia": 948,
    "Portugal": 949,
    "United Kingdom": 950,
    "Reino Unido": 950,
    "Russia": 951,
    "Rusia": 951,
    "Sweden": 952,
    "Suecia": 952,
    "Switzerland": 953,
    "Suiza": 953,
    "Turkey": 954,
    "Turquía": 954,
    "Ukraine": 955,
    "Ucrania": 955,
    "Uruguay": 956,
    "Venezuela": 957,
    "Vietnam": 958,
};

/**
 * Normaliza um rótulo para comparação: sem acento, sem diferença de maiúscula,
 * espaços e apóstrofos uniformizados. "Steel industry" e "Steel Industry",
 * "Bureau d’étude" e "Bureau d'étude" passam a ser o mesmo valor — antes a
 * comparação era exata e um "i" minúsculo deixava o campo vazio.
 */
export function normalizarRotulo(valor) {
    return String(valor || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u2018\u2019\u00b4`]/g, "'")
        .replace(/\s+/g, ' ')
        .toLowerCase()
        .trim();
}

/**
 * Procura o valor numa lista de IDs do Bitrix ignorando acento e maiúsculas.
 * Devolve '' quando não reconhece.
 */
export function idDaLista(mapa, valor) {
    const alvo = normalizarRotulo(valor);
    if (!alvo) return '';
    for (const rotulo of Object.keys(mapa)) {
        if (normalizarRotulo(rotulo) === alvo) return mapa[rotulo];
    }
    return '';
}

// Código ISO 3166 de duas letras -> nome usado no MAPA_PAIS. Os formulários
// [Contact] mandam só o código ("BR" em 12 dos 19 leads de 09/2026).
const PAIS_POR_ISO = {
    AF: 'Afghanistan', ZA: 'South Africa', DE: 'Germany', AR: 'Argentina', AU: 'Australia',
    AT: 'Austria', BD: 'Bangladesh', BE: 'Belgium', BR: 'Brazil', CA: 'Canada', CL: 'Chile',
    CN: 'China', CO: 'Colombia', KR: 'South Korea', CU: 'Cuba', DK: 'Denmark', EG: 'Egypt',
    ES: 'Spain', US: 'United States', FR: 'France', GR: 'Greece', IN: 'India', ID: 'Indonesia',
    IR: 'Iran', IE: 'Ireland', IL: 'Israel', IT: 'Italy', JP: 'Japan', LB: 'Lebanon',
    MX: 'Mexico', MZ: 'Mozambique', NG: 'Nigeria', NO: 'Norway', NZ: 'New Zealand',
    PK: 'Pakistan', PY: 'Paraguay', PE: 'Peru', PL: 'Poland', PT: 'Portugal',
    GB: 'United Kingdom', UK: 'United Kingdom', RU: 'Russia', SE: 'Sweden', CH: 'Switzerland',
    TR: 'Turkey', UA: 'Ukraine', UY: 'Uruguay', VE: 'Venezuela', VN: 'Vietnam',
};

/**
 * Converte o país do formulário no ID da lista. Aceita:
 *  - o nome em inglês, espanhol ou português ("Brazil", "Brasil");
 *  - o código ISO de duas letras ("BR", "FR");
 *  - o formato composto do formulário [Contact] ("Brasil -/- Brazil").
 * Devolve '' quando não reconhece — nunca chuta um país.
 */
export function idDoPais(pais) {
    const bruto = String(pais || '').trim();
    if (!bruto) return '';

    const direto = idDaLista(MAPA_PAIS, bruto);
    if (direto) return direto;

    if (/^[a-z]{2}$/i.test(bruto)) {
        const nome = PAIS_POR_ISO[bruto.toUpperCase()];
        return nome ? idDaLista(MAPA_PAIS, nome) : '';
    }

    for (const parte of bruto.split(/\s*(?:-\/-|\/|\|)\s*/)) {
        const id = parte && idDaLista(MAPA_PAIS, parte);
        if (id) return id;
    }
    return '';
}
