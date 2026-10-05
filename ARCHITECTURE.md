# Architecture — Distributed Wagering Processor

> Documento vivo. As decisões serão atualizadas conforme a implementação avance.

## Status

- Fase atual: implementação e validação local do núcleo financeiro, persistência e mensageria concluídas
- Implementação: domínio + PostgreSQL + Inbox/Outbox + adapters SQS
- Data: 2026-10-03

## Objetivo

Processar transações financeiras de apostas com precisão monetária, concorrência segura, idempotência persistente, ledger auditável e publicação confiável de eventos.

## Invariantes principais

1. O saldo nunca pode ser negativo.
2. Uma operação financeira não pode produzir dois efeitos.
3. Toda alteração de saldo possui um lançamento imutável no ledger.
4. Wallet, transação, ledger, Inbox e Outbox devem ser confirmados atomicamente.
5. Eventos só podem ser publicados depois do commit financeiro.
6. A correção não pode depender de uma única instância, memória local ou ordenação do broker.

## Direção inicial

- NestJS, TypeScript strict e Bun.
- MikroORM sobre PostgreSQL.
- `decimal.js` no Value Object `Money`.
- Lock pessimista por `wallet_id` usando `SELECT FOR UPDATE`.
- Inbox persistente para mensagens SQS.
- Transactional Outbox para eventos de integração.
- SQS via LocalStack em ambiente local.
- Filas separadas para entrada (`wager-transactions.fifo`) e eventos de saída (`wager-events.fifo`), evitando loop do consumidor com o Outbox.
- AuthGuard no-op como ponto de extensão documentado.
- API HTTP NestJS com `ValidationPipe` estrito, filtro de erros de domínio e health checks.

## Componentes previstos

```text
HTTP API / SQS Consumer
          |
          v
Wagering Application Use Cases
          |
          +--> PostgreSQL
          |      wallets
          |      wager_transactions
          |      wallet_ledger_entries
          |      inbox_messages
          |      outbox_messages
          |
          +--> Pending Reference Worker
          +--> Outbox Publisher
          +--> Reconciliation
```

## Evidência de validação local (2026-10-04)

- Suíte completa: 66 testes aprovados, 0 falhas e 601 verificações.
- Smoke Compose: BET via SQS confirmou saldo `100.00 → 75.00`, versão 2 e Outbox drenada.
- Carga local: 400/400 requests, zero erros, ~171,97 req/s, p95 139,82 ms, p99 176,89 ms; saldo e versão finais corretos; Outbox drenada em 4,324 s.
- Esses números são uma amostra curta local, não definem capacidade ou SLO de produção; metodologia e séries anteriores estão em [LOAD_TESTS.md](docs/testing/LOAD_TESTS.md).

Evolução para produção: separar migrations em um job de release antes de escalar
múltiplas réplicas e executar carga sustentada em ambiente representativo.

## Empacotamento e inicialização

A imagem usa Bun 1.4.2 Alpine, instala o lockfile de forma congelada, executa o
typecheck no build e roda como usuário `bun`. O Compose executa um serviço
migrator one-shot com a credencial administrativa e só inicia a API após as
migrations e as dependências ficarem saudáveis. O entrypoint do app usa `exec`
para encaminhar sinais ao processo NestJS; o health check consulta `/health/ready`.

No Compose, o administrador definido em `POSTGRES_ADMIN_USER` é reservado ao
provisionamento/migrations locais e fica somente nos containers one-shot. O
processo NestJS recebe apenas `APP_DB_USER`, role sem superuser/DDL e sem UPDATE ou DELETE em
`wallet_ledger_entries`. Em produção, migrations devem usar credencial
de release separada e a aplicação deve obter acesso SQS pela cadeia padrão do
AWS SDK (por exemplo, IAM role). Credenciais e endpoints locais são fornecidos
somente pelo `.env` ignorado pelo Git; `.env.example` contém nomes de variáveis
sem valores.

Esse startup com migration é adequado ao Compose de uma única réplica do desafio.
Em produção, migrations devem ser executadas uma vez por um job de release antes
de escalar réplicas, evitando que vários processos concorram pelo schema. A
imagem mantém CLI/TypeScript necessários às migrations em runtime, priorizando
reprodutibilidade do exercício sobre tamanho mínimo da imagem.

O volume do PostgreSQL, o estado do LocalStack e o state do Terraform persistem
entre reinícios. A aplicação usa nomes DNS da rede Compose (`postgres` e
`localstack`), enquanto testes no host usam localhost. O Terraform é a única
fonte declarativa das filas; não há criação paralela por script shell.

`infra/terraform/main.tf` declara as filas FIFO de comandos, DLQ e eventos,
além do `redrive_policy` com cinco recebimentos e da permissão de redrive da
DLQ. O provider AWS aponta para o endpoint SQS do LocalStack e recebe região,
endpoint e credenciais pelas variáveis de ambiente. Em AWS real, endpoint e
credenciais devem vir do ambiente de execução.

## Mensageria e ciclo de vida

O consumidor SQS transforma a mensagem em `ProcessBetInput` e reutiliza o mesmo
caso de uso da entrada HTTP. O `payloadHash` é SHA-256 do JSON canônico do
payload de negócio, com chaves ordenadas recursivamente; `idempotencyKey` e
metadados de transporte não entram no hash.

O `DeleteMessage` só é enviado depois que o caso de uso retorna, portanto depois
do commit do `UnitOfWork`. Exceções deixam a mensagem para redelivery. A fila
de entrada local possui redrive para a DLQ após cinco entregas. Falhas de
negócio que retornam `REJECTED` são resultado terminal e podem ser confirmadas;
falhas de infraestrutura continuam sem ACK.

O índice parcial `outbox_aggregate_pending_order_idx` acelera a consulta de
eventos anteriores ainda não publicados, sem indexar o histórico concluído.

O publisher do Outbox usa a fila de eventos, não a fila de entrada. A garantia
é at-least-once: pode existir publicação duplicada se o processo cair depois do
ACK do broker e antes de marcar `published_at`; consumidores downstream devem
ser idempotentes.

O claim do Outbox libera somente o evento pendente mais antigo de cada agregado
(para wallet, ordenado também por `walletVersion`); um evento anterior bloqueado
ou em retry impede que o seguinte ultrapasse-o, inclusive entre réplicas. O
publisher processa esses agregados sequencialmente, pode claimar até 100 eventos
de agregados independentes e envia lotes SQS de até 10 grupos distintos. O ACK
parcial do `SendMessageBatch` é tratado por evento; sucessos são marcados em um
UPDATE SQL agrupado e falhas recebem retry individual. O runtime busca a próxima
página imediatamente quando há publicações; sem trabalho elegível, espera um
segundo. Isso reduz round-trips sem paralelizar eventos da mesma wallet.

## Referências fora de ordem

`REFUND`, `ROLLBACK` e `WIN` com referência ausente são gravados sem alterar o
saldo, em `PENDING_REFERENCE`. O worker agendado busca somente registros cujo
`reference_next_attempt_at` venceu, processa no máximo 50 por rodada e aplica
backoff exponencial de 2s, 4s, 8s... limitado a 60s. Depois de cinco tentativas,
a transação é rejeitada com `REFERENCE_NOT_FOUND` e gera evento de rejeição.
Essa escolha evita polling agressivo e impede que uma referência perdida fique
pendente indefinidamente.

## Contrato HTTP atual

`POST /wallets/:walletId/reconciliation` compara saldo persistido com soma
NUMERIC de créditos menos débitos do ledger, incluindo OPENING. Usa shared
row lock da wallet e soma na mesma transação/conexão, evitando falsos
positivos durante movimentos financeiros. A diferença é `armazenado -
calculado`. Divergência retorna `consistent: false`, registra log sem valores
financeiros e incrementa contador exportado; não repara registros. O lock pode
atrasar movimentos da wallet durante a soma de históricos grandes; para
essa evolução, considerar leitura de snapshot com isolamento apropriado.

Consultas implementadas: `GET /wallets/:walletId`,
`GET /wallets/:walletId/ledger`, `GET /wagering/transactions/:transactionId`
e `GET /providers/:providerId/wagering/transactions/:externalTransactionId`.
Usam EntityManager isolado por consulta, resposta explícita e valores Money
em strings decimais. IDs UUID inválidos retornam 400; recurso ausente, 404.

O ledger usa paginação keyset em ordem ascendente `(created_at, id)`, com
limite padrão 50 e máximo 100. O cursor opaco Base64URL contém versão,
wallet e identidade do lançamento âncora. O servidor valida a âncora e
compara timestamps diretamente no PostgreSQL, preservando microssegundos.
Busca `limit + 1` para informar `nextCursor` sem COUNT/OFFSET.
O cursor é um mecanismo de navegação, não de autorização nem uma assinatura.
Esta consulta é uma visão viva: não congela um snapshot entre páginas;
inserções posteriores com timestamp anterior à âncora exigem reiniciar a
consulta. O desempate por UUID estabiliza a paginação, mas não representa a
ordem financeira de execução quando timestamps coincidem.

`POST /wallets` cria a wallet em versão 1. Para saldo inicial positivo, uma
factory interna gera OPENING processada e um lançamento CREDIT de zero ao
saldo inicial, junto com os eventos de processamento e alteração de saldo.
Todos os registros são confirmados em uma única transação SQL. Saldo zero
não gera movimento. A unicidade player/moeda é assegurada no PostgreSQL e
reportada como HTTP 409. OPENING não pode ser enviada pelo endpoint externo
de transações.

`POST /wagering/transactions` aceita o ciclo `BET`, `WIN`, `LOSS`, `REFUND` e
`ROLLBACK`. O header
`Idempotency-Key` é obrigatório; o corpo é validado na borda e convertido para
`Money` antes de entrar no caso de uso. O response preserva `transactionId`,
status, saldo observado, código de rejeição e `idempotentReplay`.

O status HTTP representa a decisão de retry do cliente: `201` para resultado
processado (inclusive replay), `202` para `PENDING_REFERENCE`, `422` para
rejeição terminal de negócio, `409` para conflito de idempotência, `400` para
contrato inválido e `503` para falhas transitórias reconhecidas de PostgreSQL ou
transporte. Recursos ausentes usam `404`. Erros inesperados retornam `500` com
mensagem genérica; detalhes internos não são enviados ao cliente.

Locks são por linha de wallet. O teste multiprocessos com 12 wallets distintas
confirma progresso paralelo sem lock global: cada saldo termina em `90.00` após
uma BET de `10.00`, e cada ledger reconstrói o saldo materializado.

`GET /health/live` mede somente o processo. `GET /health/ready` consulta
PostgreSQL e a fila SQS de entrada; falha de dependência retorna 503.

## Persistência inicial

A primeira migration cria:

- `wallets`, com saldo `NUMERIC(15,2)`, versionamento, unicidade por player/moeda e `CHECK` de saldo não negativo;
- `wager_transactions`, com unicidade por idempotency key e por transação externa;
- `wallet_ledger_entries`, com unicidade por wallet/transação e `CHECK` aritmético para débito e crédito.

A migration `Migration20261003170000` adiciona um trigger `BEFORE UPDATE OR
DELETE` que rejeita mutações no ledger. O banco permite apenas `INSERT` pelo
fluxo financeiro. A reversão da migration remove primeiro o trigger e depois a
função, permitindo rollback operacional da mudança de schema.

A migration `Migration20261003180000` remove também privilégios de mutação do
ledger para a role definida em `APP_DB_USER`, quando ela existe. A migration pode ser
revertida; a role administrativa local continua fora do processo NestJS.

As migrations foram executadas contra PostgreSQL 16 em Docker. A última foi
validada em ciclo `up → down → up`; o catálogo confirma o trigger habilitado e
SQL direto comprova a rejeição de `UPDATE` e `DELETE` sem alterar o lançamento.
