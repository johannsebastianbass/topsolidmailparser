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

## Regras de funcionamento

Definidas com o cliente em 22/09/2026:

| E-mail que chega na caixa | O que a integração faz |
| --- | --- |
| **Formulário** vindo de `no-reply@topsolid.com`, `mkt.sales@topsolid.com` ou `marketing@cadsolid.pt` | vira lead, preenchido, com o DE/PARA do e-mail no resumo |
| Mesmo formulário chegando 2× (mesmo e-mail e assunto em até 30 min) | o 2º cartão fica **Desqualificado**, sem e-mail, com aviso apontando o original |
| **Qualquer outro canal** (pessoa, flyer/QR code de feira, fornecedor, newsletter) | **nada** — fica na caixa para o marketing avaliar e converter à mão |
| Canal de formulário, mas assunto que não é formulário | nada |
| Resposta (`RE:`) | nada |
| Devolução / reclamação da SES | registra o endereço em `devolucoes.csv` e desqualifica o cartão que a caixa criou para o `mailer-daemon@`/`complaints@` (mantendo o endereço — ver abaixo) |
| Lead **criado à mão** ou já trabalhado | nunca é sobrescrito — os dados do formulário entram só como comentário |

> "O que não pode fazer é excluir ou converter todos os e-mails que chegam —
> caso contrário, vira um caos." — Fernando, TopSolid

### A integração nunca exclui lead

Não existe função de exclusão no código. Neste Bitrix, apagar o lead apaga o
vínculo do e-mail com o CRM, e a sincronização da caixa **reimporta a mensagem
e cria outro lead** cerca de 45 minutos depois (visto em 22/09: lead 31598
apagado, recriado como 31609). Excluir vira um laço. Duplicatas e lixo são
**desqualificados** (status `JUNK`), nunca apagados.

### Lead automático x lead feito à mão

A integração só sobrescreve o lead que a sincronização criou e que ninguém
tocou: origem `EMAIL` e criado até 30 minutos depois de o e-mail chegar (o
atraso normal da sincronização é de 3 a 10 min). Lead criado bem depois do
e-mail foi convertido por alguém que avaliou a mensagem, e fica como está.

### Por que o duplicado perde o e-mail

O Bitrix anexa todo e-mail novo ao cadastro que já tem aquele endereço. Um
cartão que ficasse com `mkt.sales@topsolid.com` passaria a receber **todos** os
formulários seguintes desse canal — foi assim que 380 devoluções se empilharam
num lead só. Por isso o duplicado é desqualificado **e** tem e-mail e telefone
removidos.

Com o cartão de devolução é o contrário: ele é desqualificado e **mantém** o
endereço `mailer-daemon@...`, para funcionar como ralo. Em 22/09, 176
devoluções caíram em 12 cartões, 131 delas num só (31605, já desqualificado).
A integração só desqualifica cartão da sincronização (origem `EMAIL`), ainda em
"Novo", cujo próprio e-mail é automático. Lead de pessoa nunca entra nisso.

### Como responder ao cliente com histórico

O formulário chega do Hubspot com Reply-To `mkt.sales@topsolid.com`: o botão
"Responder" **no e-mail do formulário** escreve para o Hubspot, não para o
cliente. O cartão já tem o e-mail do cliente, então responda pelo botão
**"E-mail" do cartão**. A resposta do cliente volta para o mesmo cartão, porque
o Bitrix anexa o e-mail ao cadastro que tem aquele endereço. O resumo do Mail
Parser em cada lead traz esse aviso.

## Configuração recomendada da caixa no Bitrix

Hoje a caixa `marketing@topsolidbrazil.com` cria lead automaticamente para
**todo** e-mail recebido. A integração deixa intocados os que não são
formulário, mas eles continuam virando lead — criados pelo Bitrix, não por ela.
Para que só formulário vire lead, a configuração alvo é:

1. **Criar um contato fixo para cada canal** de formulário, com o e-mail do
   canal: `no-reply@topsolid.com`, `mkt.sales@topsolid.com`,
   `marketing@cadsolid.pt`. Assim o formulário cai num remetente conhecido e o
   Bitrix registra o e-mail como atividade desse contato.
2. **Desligar a criação automática de lead** na caixa `marketing@`.

Com isso:

- formulário → cai no contato do canal → a integração **cria** o lead e vincula
  o e-mail a ele (o DE/PARA aparece na linha do tempo);
- qualquer outro e-mail → não vira nada, fica na caixa para o marketing.

**Ordem obrigatória:** instalar esta versão **antes** de criar os contatos. A
versão anterior não conferia o tipo do dono da atividade: um formulário caindo
num contato faria ela atualizar um *lead* qualquer com o mesmo número de ID.

A integração funciona nos dois modos — com a criação automática ligada (preenche
o lead que o Bitrix criou) e desligada (cria o lead a partir do contato) —,
então a troca pode ser feita sem parar nada.

**Outras caixas:** se a caixa de algum usuário estiver criando lead sozinha
(visto com o usuário 132: "Financeiro", "Estefani Silva"), é a opção de criação
automática marcada por engano na sincronização dessa caixa.

## Depois de uma campanha de marketing

Cada devolução, supressão ou reclamação que chega na caixa monitorada é gravada
em **`devolucoes.csv`** (na pasta da aplicação) **antes** de o lead-lixo ser
apagado — inclusive com a exclusão desligada. É a lista que o marketing usa
para limpar a base de envio:

```bash
cat /opt/topsolid-mailparser/devolucoes.csv
sudo journalctl -u topsolid-mailparser | grep DEVOLUÇÃO
```

O CSV separa devolução **permanente** (5xx: endereço não existe, tirar da lista)
de **temporária** (4xx: caixa cheia, manter).

Para o histórico que já estava no CRM antes desta versão, ou para
desqualificar leads-lixo pendentes:

```bash
node tools/devolucoes.mjs 2026-09-01     # extrai do CRM, com tipo
node tools/limpeza.mjs lixo              # leads-lixo de devolução (simulação)
node tools/limpeza.mjs lixo --aplicar    # marca como Desqualificado, com backup
```

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
| `tools/limpeza.mjs` | Remove contatos repetidos e desqualifica leads-lixo (simulação por padrão, com backup e reversão) |
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
