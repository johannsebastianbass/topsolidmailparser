import app from './src/app.js';
import config from './src/config.js';
import { log, erro } from './src/logger.js';

const port = process.env.PORT || 3000;

// Falhar aqui, alto e claro, é melhor que subir e errar todas as chamadas.
if (!config.bitrix.webhook) {
    console.error('BITRIX_WEBHOOK não definido. Configure no ambiente ou no arquivo .env.');
    process.exit(1);
}

// Rede de segurança: uma promise rejeitada sem catch derruba o processo em
// Node 15+. Preferimos registrar e continuar servindo os próximos webhooks.
process.on('unhandledRejection', (motivo) => erro('promise sem tratamento', motivo));
process.on('uncaughtException', (e) => erro('exceção não capturada', e));

if (!config.tokenWebhookSaida) {
    log('AVISO: BITRIX_APPLICATION_TOKEN não definido — o endpoint /topSolid aceita qualquer requisição. Pegue o token na tela do webhook de saída do Bitrix.');
}

const server = app.listen(port, () => {
    log(`server TopSolid on :${port}`);
});

for (const sinal of ['SIGINT', 'SIGTERM']) {
    process.on(sinal, () => {
        log(`${sinal} recebido; encerrando`);
        server.close(() => process.exit(0));
    });
}
