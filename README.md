# TopSolid Mail Parser

Recebe o webhook de atividade do Bitrix24, identifica de qual formulário do site
veio o e-mail, extrai os campos do corpo HTML e atualiza o lead correspondente.

## Como rodar

```bash
npm install
npm start        # produção
npm run dev      # nodemon
npm test         # testes do parser (não acessa o Bitrix)
```

## Configuração

No servidor, só o arquivo `.env` (que não vai para o git) com **duas linhas**:

```
BITRIX_WEBHOOK=https://crm.topsolidbrazil.com/rest/1/SEU_TOKEN
BITRIX_APPLICATION_TOKEN=
```

Há um `.env.example` pronto para copiar. Todo o resto já vem com valor no
código (`src/config.js`) e só precisa entrar no `.env` para sobrescrever:

| Variável | Padrão | Para que serve |
| --- | --- | --- |
| `BITRIX_WEBHOOK` | — (**obrigatória**) | Webhook REST de entrada. Sem ela o servidor nem sobe |
| `BITRIX_APPLICATION_TOKEN` | vazio | Token do webhook de **saída**. Sem ele, `/topSolid` aceita qualquer origem |
| `PORT` | `3000` | Porta do servidor |
| `CAIXAS_MONITORADAS` | `marketing@topsolidbrazil.com` | Caixa(s) que recebem os formulários |
| `REMETENTES_PERMITIDOS` | `no-reply@topsolid.com`, `mkt.sales@topsolid.com`, `marketing@cadsolid.pt` | Quem envia/encaminha os formulários |
| `BITRIX_EXCLUIR_LEAD_DESCONHECIDO` | `false` | Com `true`, exclui o lead de e-mail cujo assunto não é de formulário conhecido |
| `BITRIX_ASSIGNED_BY_ID` | `105` | Responsável atribuído ao lead (Fernando Pasquali) |
| `BITRIX_PAIS_PADRAO` | `919` (Brasil) | País quando o formulário não traz o campo |
| `BITRIX_INTERVALO_MS` | `550` | Intervalo mínimo entre chamadas (limite ~2 req/s na nuvem) |
| `BITRIX_TIMEOUT_MS` | `15000` | Timeout de cada chamada |
| `BITRIX_DOMINIO` | derivado do webhook | Base dos links do mural |
| `UF_*` | IDs atuais | Sobrescrevem os códigos dos campos customizados |

Os IDs de campo e de lista **são específicos de cada portal**. Ao trocar de
portal, rode `node tools/verificar.mjs` antes de subir.

## Instalação no servidor do Bitrix (on-premise)

A aplicação roda como serviço systemd na mesma máquina do Bitrix, e o Bitrix a
chama por um webhook de saída.

```bash
git clone <repo> /opt/topsolid-mailparser
cd /opt/topsolid-mailparser
npm ci --omit=dev
cp .env.example .env      # e preencha as duas linhas
node tools/verificar.mjs  # confere o portal antes de subir
```

Serviço (`/etc/systemd/system/topsolid-mailparser.service`):

```ini
[Unit]
Description=TopSolid Mail Parser (integração Bitrix24)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=zopu
WorkingDirectory=/opt/topsolid-mailparser
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=topsolid-mailparser

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now topsolid-mailparser
sudo journalctl -u topsolid-mailparser -f
```

### O Bitrix NÃO entrega webhook em localhost

Este é o ponto que custa horas se não estiver escrito. Um webhook de saída
apontando para `http://localhost:3000/topSolid` **nunca é chamado**: o Bitrix
descarta em silêncio — sem erro na tela, sem linha em `b_rest_log`, sem nada na
fila `b_rest_event_offline`. O handler aparece corretamente em `b_rest_event` e
mesmo assim não dispara.

A solução é expor a aplicação por uma URL normal do próprio domínio, com o
nginx repassando para a porta local. No BitrixVM, crie
`/etc/nginx/bx/site_settings/default/mailparser.conf`:

```nginx
location ^~ /mailparser/ {
    proxy_pass http://127.0.0.1:3000/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Dois detalhes que importam:

- **`^~` é obrigatório.** Sem ele, uma `location` com regex do `bitrix.conf`
  vence o prefixo e a requisição cai no PHP do Bitrix (você recebe a tela de
  login em vez da resposta da aplicação).
- **A barra final do `proxy_pass`** é o que remove o prefixo: `/mailparser/topSolid`
  chega na aplicação como `/topSolid`.

```bash
sudo nginx -t && sudo systemctl reload nginx
curl -s https://SEU_PORTAL/mailparser/health
```

### Webhook de saída no Bitrix

**Aplicativos → Recursos para desenvolvedores → Outros → Webhook de saída**

- URL: `https://SEU_PORTAL/mailparser/topSolid`
- Evento: `ONCRMACTIVITYADD` — **somente esse**. Marcar também
  `ONCRMACTIVITYUPDATE` faz cada e-mail ser processado duas vezes.

Copie o token exibido e coloque em `BITRIX_APPLICATION_TOKEN` no `.env`, depois
reinicie o serviço. Sem o token o endpoint aceita requisição de qualquer origem;
com ele, responde 403 para quem não for o portal.

Para testar sem depender de e-mail, crie qualquer atividade no CRM ("A fazer",
"Ligação"). O log deve mostrar `atividade N não é e-mail (CRM_TODO/TODO);
ignorada` — o que prova a cadeia inteira.

## O que a integração exclui (e o que nunca exclui)

A exclusão só acontece com `BITRIX_EXCLUIR_LEAD_DESCONHECIDO=true`. Desligada, o
log registra `lead N SERIA excluído` — use isso para conferir antes de ligar.

Mesmo ligada, **todo** caso passa pela mesma função com as mesmas travas: o lead
tem que pertencer à atividade, ainda estar como o Bitrix o criou a partir do
e-mail (`SOURCE_ID = EMAIL`) e atender à regra do caso. Lead que alguém já
trabalhou, ou que a integração já preencheu, nunca é apagado.

| Caso | O que acontece |
| --- | --- |
| Formulário reconhecido | preenche o lead |
| Mesma submissão chegando 2× (mesmo e-mail e assunto em até 30 min) | apaga o 2º cartão e avisa no mural do original |
| Devolução / reclamação / supressão da SES | apaga o lead-lixo criado para o remetente automático |
| Remetente de formulário com assunto desconhecido | apaga o lead cru |
| **Pessoa real escrevendo para o marketing** | **mantém o lead intacto** |
| Resposta (`RE:`) | mantém o lead intacto |

Os três primeiros casos de exclusão vieram de problemas reais em produção: o
Hubspot às vezes manda a notificação de formulário duas vezes com 1 segundo de
diferença, e uma campanha para uma lista ruim gera centenas de devoluções que
viram atividades na caixa monitorada.

**Leads-lixo de remetente automático:** o Bitrix às vezes grava o endereço no
nome e no título e deixa o campo EMAIL vazio (acontece com as reclamações da
SES). A regra considera isso — mas só aceita o nome/título se for de fato um
endereço de e-mail automático, então um lead de pessoa real sem e-mail nunca é
confundido.

## Depois de uma campanha de marketing

```bash
node tools/devolucoes.mjs 2026-09-01     # endereços que devolveram, com tipo
node tools/limpeza.mjs lixo              # leads-lixo de devolução (simulação)
node tools/limpeza.mjs lixo --aplicar    # apaga, com backup
```

Rode o `devolucoes.mjs` **antes** do `lixo --aplicar`: apagar o lead-lixo apaga
junto as devoluções anexadas a ele. O CSV separa devolução **permanente** (5xx:
endereço não existe, tirar da lista) de **temporária** (4xx: caixa cheia, manter).

Continuar mandando para endereço que devolve derruba a reputação da conta na
Amazon SES. Acima de 5% de devolução a conta entra em revisão; acima de 10%, o
envio é pausado.

## Estrutura

| Arquivo | Responsabilidade |
| --- | --- |
| `server.js` | Sobe o HTTP, trata sinais e erros de processo |
| `src/app.js` | Rotas e validação do webhook |
| `src/topSolid.js` | Fluxo: atividade → layout → lead |
| `src/layouts.js` | Catálogo dos formatos de e-mail (onde começa/termina cada campo) |
| `src/htmlParser.js` | Extração e limpeza de valores do HTML |
| `src/lead.js` | Monta e envia a atualização do lead e os posts do mural |
| `src/bitrix.js` | Cliente REST do Bitrix (timeout + checagem de `data.error`) |
| `src/config.js` | Configuração central |
| `test/parser.test.mjs` | Testes do parser com amostras dos e-mails reais |
| `tools/verificar.mjs` | Confere webhook, escopos, usuário, campos e IDs de lista do portal |
| `tools/limpeza.mjs` | Remove contatos repetidos e leads-lixo (simulação por padrão, com backup e reversão) |
| `tools/devolucoes.mjs` | Lista os endereços que devolveram numa campanha, para tirar da lista de envio |
| `tools/diagnostico.mjs` | Inspeção somente-leitura do CRM (e-mails acumulados, leads duplicados) |

## Diagnóstico

Somente leitura, não altera nada no CRM:

```bash
node tools/verificar.mjs                 # o portal está configurado como o código espera?
node tools/diagnostico.mjs lead 12345    # e-mails/telefones de um lead
node tools/diagnostico.mjs acumulados    # leads com mais de um e-mail no cartão
node tools/diagnostico.mjs duplicados    # o mesmo e-mail em vários leads
```

## Suportar um formulário novo

Adicione um objeto em `LAYOUTS` (`src/layouts.js`) com:

- `combina(assunto)` — como reconhecer o e-mail;
- `fim` — a tag que fecha cada campo (`</p>`, `</li>`, ...);
- `campos` — para cada campo, o rótulo onde ele começa (`de`) e o rótulo do
  campo seguinte (`ate`); `tipo: 'email'` liga a busca por `mailto:`;
- `resumo` — quais campos entram no post de "Informações Brutas" do mural.

Nenhum código novo é necessário. Vale acrescentar um caso em
`test/parser.test.mjs` com uma amostra do HTML real.

## Nota

`server2.js` é a versão monolítica antiga, não é importada por nada e não roda.
Mantida apenas como referência histórica.
