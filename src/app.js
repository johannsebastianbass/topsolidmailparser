import express from 'express';
import topSolid from './topSolid.js';
import config from './config.js';
import { log, erro } from './logger.js';

const app = express();

// O Bitrix envia o webhook como x-www-form-urlencoded, mas testes manuais
// costumam mandar JSON. Aceitamos os dois.
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

app.get('/teste', (req, res) => {
    res.status(200).json({ message: 'Teste' });
});

app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Rotas mantidas da versão anterior: ainda são placeholders, o log continua
// saindo no stdout do processo.
app.get('/log', (req, res) => {
    res.status(200).json({ message: 'log' });
});

app.get('/logErro', (req, res) => {
    res.status(200).json({ message: 'log de erro' });
});

/**
 * Extrai o ID da atividade do corpo do webhook sem estourar quando o formato
 * vem diferente do esperado.
 */
function lerIdAtividade(body) {
    const data = body && body.data;
    const fields = data && data.FIELDS;
    const id = fields && fields.ID;
    return id ? String(id) : null;
}

/**
 * O webhook de saída manda o token do portal em auth[application_token].
 * Conferir isso impede que um terceiro que descubra a URL dispare
 * processamento — inclusive exclusão de lead.
 */
function tokenValido(body) {
    const esperado = config.tokenWebhookSaida;
    if (!esperado) return true;   // não configurado: aceita (com aviso no boot)
    const recebido = body && body.auth && body.auth.application_token;
    return recebido === esperado;
}

app.post('/topSolid', (req, res) => {
    if (!tokenValido(req.body)) {
        log('webhook recusado: application_token ausente ou diferente');
        return res.status(403).json({ message: 'token inválido' });
    }

    const idActivity = lerIdAtividade(req.body);

    if (!idActivity) {
        log('webhook recebido sem data.FIELDS.ID', req.body);
        return res.status(400).json({ message: 'data.FIELDS.ID ausente' });
    }

    log(`webhook recebido para a atividade ${idActivity}`);

    // Responde na hora: o Bitrix reenvia o webhook se demorarmos, e o
    // processamento pode levar vários segundos.
    res.status(200).json({ message: 'dados recebidos' });

    // topSolid já trata os próprios erros; o catch aqui é só a última rede.
    topSolid(idActivity).catch((e) => erro(`atividade ${idActivity}`, e));
});

app.use((req, res) => {
    res.status(404).json({ message: 'rota não encontrada' });
});

app.use((e, req, res, next) => {
    erro(`requisição ${req.method} ${req.originalUrl}`, e);
    if (res.headersSent) return next(e);
    res.status(500).json({ message: 'erro interno' });
});

export default app;
