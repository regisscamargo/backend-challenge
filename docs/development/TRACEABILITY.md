# Requirements Traceability

| Requisito | Implementação prevista | Teste previsto | Status |
|---|---|---|---|
| Consultas e ledger paginado | `WageringQueries` + controllers GET | HTTP, empate temporal e cursor inválido | Validado: PostgreSQL/HTTP reais |
| Criar wallet com OPENING | `CreateWalletUseCase` + `POST /wallets` | Saldo positivo/zero, duplicata e falha no commit | Validado: PostgreSQL e HTTP reais |
| Dinheiro sem `number` | `Money` com `decimal.js` | Unidade de Money | Validado: 9 testes |
| Saldo não negativo | Domínio + `CHECK` no PostgreSQL | BET sem saldo e concorrência | Domínio + schema + integração |
| Ledger imutável | Domínio sem mutações + trigger PostgreSQL append-only | SQL direto tenta UPDATE e DELETE | Validado: banco rejeita ambos e preserva o lançamento |
| Wallet e ledger atômicos | `ApplyWalletMovementUseCase` + `UnitOfWork` | Falha antes do commit | Validado: PostgreSQL real |
| Idempotência | `provider_id` + `idempotency_key` + hash | Replay, payload conflitante e 50 cópias concorrentes | Validado: PostgreSQL real, três processos |
| Inbox persistente | `inbox_messages` + `SqsWagerTransactionConsumer` | Redelivery SQS após commit sem ACK | Validado: PostgreSQL + LocalStack reais |
| Outbox transacional | `outbox_messages` + eventos versionados | Replay não duplica efeitos financeiros | Validado em PostgreSQL real |
| Publisher concorrente | `SKIP LOCKED` + publish-after-claim | Dois processos e registros bloqueados | Validado: claims disjuntos e 12 eventos recebidos no LocalStack |
| Recuperação de publisher morto | Lease em `locked_at` | Lock expirado é reclamado | Validado em PostgreSQL real |
| Referência fora de ordem | `PENDING_REFERENCE` + worker agendado + backoff | REFUND antes da BET | Validado: PostgreSQL real |
| Concorrência por wallet | `SELECT FOR UPDATE` | 15 BETs disputando saldo para dez | Validado: três processos, saldo e ledger consistentes |
| Múltiplas instâncias | Banco como autoridade | Três processos simultâneos | Validado: processos Bun independentes no PostgreSQL real |
| Wallets distintas em paralelo | Lock por linha, sem lock global | 12 wallets em três processos | Validado: todas em 90.00 e todos os ledgers consistentes |
| Contrato HTTP | Status por classe de resultado/erro | Inválido, conflito, processado, pendente, rejeitado e infraestrutura | Validado: 400/409/201/202/422/503 |
| Reconciliação | Soma NUMERIC + Money + shared lock + endpoint HTTP | Divergência e movimentos concorrentes | Validado: PostgreSQL/HTTP reais e métrica exportada |
| Health checks | `/health/live` e `/health/ready` | PostgreSQL/SQS indisponíveis | Validado: HTTP + dependências reais |
| Observabilidade | Logs JSON + GET /metrics Prometheus | Allowlist, contadores e scrape PostgreSQL/SQS | Validado; runtime contínuo conectado |
| Retry e DLQ | Visibilidade SQS + redrive policy | Falha transitória e poison message | Validado: LocalStack real |
| Runtime contínuo | Consumer + publisher + drain | Commit, ACK e eventos publicados | Validado: PostgreSQL isolado + LocalStack reais |
| Crash pós-commit | Inbox + idempotência persistentes | SIGKILL antes do ACK, outro processo recebe e confirma | Validado: PostgreSQL migrado + LocalStack reais, efeito financeiro único |
| Crash após envio de evento | Lease + eventId estável + publish-after-claim | SIGKILL após aceite SQS antes de published_at | Validado: expiração real do lease, reenvio e marcação por novo processo |
| Execução via Compose | Dockerfile + entrypoint + Terraform + dependências saudáveis | Build, apply idempotente, restart, readiness e BET real por SQS | Validado: saldo 100.00 → 75.00, version 2 e Outbox drenada |

## HTTP/NestJS

- `POST /wagering/transactions` usa `ProcessBetUseCase`, sem duplicar regra financeira.
- `ValidationPipe` está configurado com whitelist, transformação e rejeição de campos desconhecidos.
- `playerId` e `walletId` são validados como UUID antes de chegar ao PostgreSQL.
- O filtro HTTP preserva validação 400, mapeia ausência para 404, conflitos para 409, falhas transitórias conhecidas para 503 e erros inesperados para resposta 500 genérica sem vazar detalhes.
- `POST /wagering/transactions` retorna 201 processado/replay, 202 pendente e 422 rejeitado com corpo auditável.
- `NoopAuthGuard` está isolado como ponto explícito de substituição por JWT.
- Boot e endpoints foram verificados com PostgreSQL e LocalStack ativos.

## Ciclo completo de transações

### Evidência adicional: disputa de reversões

REFUND e ROLLBACK foram testados com duas solicitações distintas em paralelo
no PostgreSQL. Exatamente uma reversão foi aplicada por tipo/referência. A
outra ficou auditável como `REFERENCE_ALREADY_REVERSED`. Testado também
ROLLBACK sem saldo: rejeição persistente com código específico, ausência de
ledger, replay original preservado após crédito e nova reversão permitida
com identidade diferente. Nos três cenários o saldo final foi reconstruído
integralmente pelo ledger, partindo de wallet com saldo zero.

### Evidência adicional: referências inválidas

Oito cenários de integração PostgreSQL comprovam rejeição persistente e replay:
rodada diferente, player diferente, moeda diferente, reversão parcial, REFUND
de WIN, WIN de WIN, ROLLBACK de LOSS e referência REJECTED. Cada rejeição
conclui a Inbox e gera um único evento na Outbox, sem alterar saldo/versão ou
criar ledger. Concorrência entre processos está documentada em [CONCURRENCY_TESTS.md](../testing/CONCURRENCY_TESTS.md);
reconciliação possui testes próprios de consistência, divergência e métricas.

- `BET`: débito e rejeição por saldo insuficiente.
- `WIN`: crédito, com referência opcional à BET da rodada.
- `LOSS`: persistido como processado sem movimento de saldo.
- `REFUND`: crédito somente para BET processada, uma vez, com mesmo valor.
- `ROLLBACK`: direção inversa para BET, WIN ou REFUND processada, uma vez, com mesmo valor.
- Referência ausente: `PENDING_REFERENCE`, Outbox de pendência, retry com backoff e limite de cinco tentativas.
- Reversão sem saldo: `REVERSAL_WOULD_CREATE_NEGATIVE_BALANCE`.

## Evidências da etapa atual

- LocalStack Community `3.8.1` sobe sem token Pro.
- `wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wager-events.fifo` criadas localmente.
- Redrive da fila de entrada configurado para `maxReceiveCount=5`.
- Consumer testado: sucesso confirma e apaga; falha de infraestrutura não apaga.
- Hash canônico testado contra variação de ordem das chaves.
