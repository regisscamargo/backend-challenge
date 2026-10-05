# Changelog

## Unreleased

### Added

- Role PostgreSQL de runtime configurada por `APP_DB_USER`, sem superuser e sem UPDATE/DELETE no ledger; credenciais e endpoints são lidos do `.env` local ignorado pelo Git, enquanto `.env.example` contém apenas nomes de variáveis vazios.
- Validação de escala monetária estrita (2 casas, limite NUMERIC(15,2)), conflito de `externalTransactionId` mapeado para 409 e cliente SQS usando provider chain fora do LocalStack.
- Diagrama arquitetural interativo na página `/demo`, com justificativas e trade-offs por componente.
- Página interativa `/demo` com fluxo de processamento, criação de wallet local, envio de transação e inspeção do retorno/idempotência.
- Índice de documentação no README e organização dos guias complementares sob `docs/` por assunto.

- Terraform declarativo para filas FIFO, DLQ, redrive policy e fila de eventos no LocalStack.
- Serviço Terraform one-shot no Compose com state e plugins em volumes persistentes.

- Imagem Bun não root, entrypoint de migrations e serviço completo da aplicação no Docker Compose.
- Health checks e dependências ordenadas para PostgreSQL, filas LocalStack e readiness da API.
- Smoke test test:compose cobrindo API, SQS, worker financeiro, consultas e drenagem da Outbox.
- Guia de inicialização e comandos de teste no README.

- Concorrência de 12 wallets distintas em três processos, com reconstrução individual de cada saldo pelo ledger.
- Contrato HTTP explícito para processado, pendente, rejeitado, conflito, entrada inválida e infraestrutura transitória.
- Respostas 500 genéricas sem exposição de mensagem interna e testes do classificador 503.

- Migration reversível com trigger PostgreSQL que torna wallet_ledger_entries append-only.
- Teste SQL real de UPDATE/DELETE rejeitados e preservação integral do lançamento.
- Limpeza de fixtures com bypass de triggers restrito à transação de teste.

- Dois testes SIGKILL com recuperação em processos novos: commit antes do ACK e aceite SQS antes de published_at.
- Harness IPC compartilhado nos testes, comando test:recovery e guia [CRASH_RECOVERY_TESTS.md](docs/testing/CRASH_RECOVERY_TESTS.md).

- Testes multiprocessos: disputa por saldo, 50 cópias idênticas e dois publishers com SKIP LOCKED sob bloqueio real.
- Comando test:concurrency e guia [CONCURRENCY_TESTS.md](docs/testing/CONCURRENCY_TESTS.md) com resultados esperados, isolamento e limites.

- Cinco testes PostgreSQL/LocalStack: redelivery pós-commit, retry contínuo, duplicata explícita, FIFO DLQ, eventos e runtime completo.
- Comando test:messaging e guia de evidências/limites [MESSAGING_TESTS.md](docs/testing/MESSAGING_TESTS.md).

### Corrected

- Rastreabilidade atualizada com provas multiprocessos; a pendência de imutabilidade SQL foi encerrada pela migration posterior.

### Added (etapas anteriores)

- Runtime contínuo SQS/Outbox no entrypoint, opt-out por WORKERS_ENABLED e drain no desligamento.
- Contextos ORM isolados para claims/retries do publisher e timeout de envio SQS.
- Teste de início único e desligamento durante publicação.

- GET /metrics Prometheus, logs JSON correlacionados e métricas de processamento, replays, retries, conflitos SQL, latência, reconciliação, Outbox e DLQ.
- Testes de sanitização por allowlist e scrape real PostgreSQL/LocalStack.

- Reconciliação HTTP com soma exata do ledger, leitura consistente, diagnóstico de divergência e contador local.
- Testes de divergência sem reparo e reconciliação durante movimentos concorrentes.

- Consultas HTTP de wallet/transações e ledger com cursor opaco, ordenação keyset, limite validado e valores monetários em strings.
- Teste HTTP de paginação com timestamps iguais, isolamento por provider e erros de consulta.

- POST /wallets com OPENING, crédito no ledger e eventos Outbox atômicos; saldo zero sem movimento e conflito player/moeda em HTTP 409.
- Testes de criação concorrente, rollback por falha injetada e contrato HTTP de criação.

- Testes PostgreSQL de REFUND/ROLLBACK concorrentes e rollback sem saldo, com replay das rejeições e reconstrução do saldo pelo ledger.

- Documentação inicial de arquitetura.
- Registro de decisões arquiteturais.
- Diário de implementação.
- Matriz inicial de rastreabilidade.
- Value Object `Money` com validação decimal.
- Aggregate Root `Wallet` com débito e crédito.
- Testes unitários iniciais de domínio.
- Lockfile Bun e validação TypeScript strict.
- Entidade imutável `WalletLedgerEntry` com validação aritmética.
- Caso de uso transacional de movimento da wallet com ports de persistência.
- Adapters MikroORM schema-first e teste de integração real com PostgreSQL.
- Teste de concorrência real com duas transações disputando a mesma wallet.
- `WagerTransaction`, processamento de BET e idempotência persistente com replay original.
- Eventos versionados e Transactional Outbox persistida com wallet, ledger e transação.
- Publisher concorrente da Outbox com reserva e confirmação pós-publicação.
- Consumer SQS com Inbox, hash canônico, ACK após processamento e preservação de redelivery em falhas.
- Ambiente LocalStack Community pinado na versão `3.8.1`, com filas de entrada, DLQ e eventos.
- Bootstrap NestJS, controller HTTP de BET, validação estrita, filtro de erros e health checks.
- Ciclo financeiro de WIN, LOSS, REFUND e ROLLBACK com referências e ledger correto.
- Worker de referências pendentes com backoff, limite de tentativas e evento de pendência.

### Changed

- Separadas as filas de entrada e saída para impedir loop entre consumer e Outbox.
- Publisher Outbox com batch SQS de até 10 agregados distintos, ACK parcial por mensagem e claims ordenados por agregado; runtime drena páginas sem pausa fixa.
- Índice parcial para acelerar a busca da próxima mensagem Outbox não publicada por agregado.

### Fixed

- Referências inválidas persistem rejeição auditável com Inbox/Outbox em vez de perder o registro por rollback da regra de negócio.
- WIN com referência valida moeda e tipo BET; detecção de reversão duplicada aplica-se somente a REFUND/ROLLBACK.

- Removido o uso de `localstack:latest`, que exigia token Pro no ambiente atual.
- Corrigida a ordem de validação da wallet antes do insert da transação, evitando foreign key 500 para wallet inexistente.
