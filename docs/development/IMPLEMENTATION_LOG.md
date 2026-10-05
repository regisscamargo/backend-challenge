# Implementation Log

## 2026-10-04 — Revisão final, configuração e validação ponta a ponta

- Credenciais, endpoints, URLs de banco, região e portas locais foram externalizados para `.env`; `.env` e variantes são ignorados pelo Git/Docker. `.env.example` mantém 25 nomes sem valores. Scan de padrões de credenciais em arquivos versionáveis: limpo.
- Removidos fallbacks sensíveis/localizados do runtime e dos testes; clients de teste SQS compartilham factory que exige configuração de ambiente. Role PostgreSQL da aplicação passou a usar `APP_DB_USER` e foi validada em ciclo migration down/up.
- README e guias corrigidos para executar Bun com `--env-file=.env`, explicar variáveis vazias e declarar que o AuthGuard no-op é somente para o desafio, não uma barreira de produção.
- Validação atual: build Docker com typecheck; Compose válido; Terraform plan `No changes`; suíte 66/66 aprovada (601 expectations); smoke SQS repetido com saldo 75.00/version 2; readiness PostgreSQL/SQS ok e `/demo` HTTP 200.
- Carga local: 400/400 requests, zero erros, 171.97 req/s, p50/p95/p99 61.49/139.82/176.89 ms; saldo/version esperados e Outbox drenada em 4.324 s. Detalhes em [LOAD_TESTS.md](../testing/LOAD_TESTS.md); não representa capacidade de produção.
- Preparação do Git: arquivos do projeto staged; `.env` não staged; guia pessoal não incluído. Nenhum commit ou push realizado.

## Organização da documentação

- Mantidos `README.md` e `ARCHITECTURE.md` na raiz para atender ao fluxo de entrada e à avaliação do desafio.
- Decisões, histórico/rastreabilidade, provas de teste e guias operacionais foram agrupados em `docs/architecture`, `docs/development`, `docs/testing` e `docs/operations`.
- Links internos atualizados e índice adicionado ao README para navegação direta.

## Terraform para mensageria local — etapa incremental

- `infra/terraform/main.tf` tornou-se a fonte declarativa única das três filas FIFO, DLQ, redrive policy com maxReceiveCount=5 e redrive allow policy.
- Serviço `terraform:1.9.8` foi adicionado ao Compose; aguarda LocalStack saudável, executa init/apply e finaliza com código 0. A aplicação depende de `service_completed_successfully`.
- O script shell anterior de criação manual das filas foi removido para eliminar duas fontes de verdade. O health check do LocalStack verifica a API; a existência das filas é responsabilidade do Terraform.
- State e plugins ficam em volumes nomeados (`terraform-state`, `terraform-plugins`), e `.terraform` foi excluído do versionamento. O lockfile do provider AWS foi preservado em `infra/terraform/.terraform.lock.hcl`.
- Validação real: provider AWS v5.100.0 instalado no container, apply criou quatro recursos, segundo apply produziu `No changes`, Compose iniciou a aplicação e smoke SQS confirmou saldo 100.00 → 75.00/version 2 e Outbox drenada.
- Documentação atualizada para o fluxo IaC; produção deve usar job de release antes de escalar réplicas.

## Empacotamento Docker Compose — etapa incremental

- Dockerfile baseado em oven/bun:1.4.2-alpine, lockfile congelado, typecheck durante build, usuário bun e entrypoint com exec.
- Entrypoint executa migration:up antes do NestJS e registra início/fim em JSON. Restart confirmou migrations idempotentes e novo boot saudável.
- Compose agora inclui app, URLs internas para postgres/localstack, WORKERS_ENABLED=true, init, stop_grace_period=60s e health check de /health/ready.
- App depende do PostgreSQL saudável e do health do LocalStack que exige a fila de entrada já criada. Mount do Docker socket foi removido porque SQS não precisa dele.
- Build real da imagem concluído. Liveness e readiness responderam 200; readiness confirmou postgres=up e sqs=up. Container ficou healthy após restart.
- Smoke test test:compose criou wallet 100.00 pela API, publicou BET 25.00 no SQS real, observou saldo 75.00/version 2, consultou a transação processada e aguardou Outbox pendente zero. Fixture removida no teardown restrito.
- README, ARCHITECTURE e TRACEABILITY atualizados. Documentado que migrations no entrypoint servem à réplica única do desafio; produção deve usar job de release antes de escalar.
- Validação desta etapa: docker compose config, TypeScript, build da imagem, boot, restart, health e smoke end-to-end passaram.

## Wallets paralelas e contrato HTTP — etapa incremental

- Teste multiprocessos distribui 12 wallets distintas entre três PIDs. Todas as BETs são processadas, geram IDs distintos, terminam em saldo 90.00 e possuem dois lançamentos; cada ledger reconstrói seu saldo.
- POST /wagering/transactions agora define status pela resposta persistida: 201 PROCESSED/replay, 202 PENDING_REFERENCE e 422 REJECTED. Conflitos continuam 409 e entradas inválidas 400.
- Filtro global unificado preserva HttpException do Nest, mapeia DomainError e reconhece indisponibilidade PostgreSQL/transporte como 503. Erros inesperados retornam 500 genérico sem propagar mensagens internas.
- Teste HTTP real cobre payload inválido, header ausente, processamento, replay, payload conflitante, saldo insuficiente e referência ausente. Teste unitário cobre códigos SQL retryable, timeout, AWS retryable e ausência de classificação para 23505/erros de programação.
- Documentação de arquitetura, concorrência e rastreabilidade atualizada; removida observação obsoleta sobre métrica de reconciliação pendente.

## Ledger imutável no PostgreSQL — etapa incremental

- Migration20261003170000 cria função PL/pgSQL e trigger BEFORE UPDATE OR DELETE em wallet_ledger_entries. Ambas as operações falham com P0001 e mensagem estável; INSERT continua sendo o único caminho normal.
- Teste de integração executa SQL direto, verifica as duas rejeições, confirma amount/balance_before/balance_after intactos, uma única linha e trigger habilitado no catálogo.
- Migration validada no PostgreSQL 16 em ciclo real up, down e up; todas as seis migrations aparecem executadas ao final.
- Teardowns que removem fixtures financeiras agora usam SET LOCAL session_replication_role=replica dentro de uma transação exclusiva de teste. O escopo termina no commit e o bypass não existe em src. Isso exige o superusuário do ambiente local; produção deve usar papel sem esse privilégio.
- Scripts de migration corrigidos de bunx para bun x, compatíveis com o runtime instalado.
- ARCHITECTURE, DECISIONS e TRACEABILITY atualizados; a lacuna obrigatória de imutabilidade no schema foi encerrada.

## Recuperação após morte real do processo — etapa incremental

- Adicionados dois testes PostgreSQL/LocalStack com SIGKILL real, barreiras IPC e recuperação em novos processos/PIDs.
- Consumer interrompido após commit antes de DeleteMessage: saldo 75.00, version 2, uma BET, um débito, uma Inbox concluída e quatro eventos permaneceram idênticos antes/depois da morte e depois da recuperação. Novo processo retornou replay da mesma transação e confirmou ACK; fila terminou vazia.
- Publisher interrompido após aceite SendMessage antes de markPublished: o teste recebeu o evento na fila com published_at ainda nulo. Claim permaneceu protegido até expirar o lease real de 5s; novo processo enviou o mesmo eventId e marcou published_at, liberando o lock.
- Dois aceites de envio foram observados; a FIFO pode suprimir a segunda entrega dentro da janela de deduplicação. Não há alegação de entrega exactly-once. attempts permanece zero porque a morte não passa pelo catch de retry.
- Wrappers de pausa e harness IPC ficam somente em test/support. Harness de subprocessos reutilizado pela suíte de concorrência. Código de produção não alterado.
- Consumer testado no schema migrado com fixtures UUID; publisher em schema UUID exclusivo gerado pelo ORM. Filas e fixtures exclusivas removidas ao final; processos mortos foram somente filhos criados pelos testes.
- Comando test:recovery e guia [CRASH_RECOVERY_TESTS.md](../testing/CRASH_RECOVERY_TESTS.md) adicionados; rastreabilidade e guias de mensageria/concorrência atualizados.
- Validação: testes dedicados 2/2; TypeScript sem erros; suíte completa 56 testes, 483 expectativas, zero falhas.

## Concorrência multiprocessos — etapa incremental

- Adicionada suíte test:concurrency e worker de teste com IPC, inicialização coordenada e ORM/pool próprios por processo.
- Três PIDs distintos disputaram 15 BETs de 10.00 contra saldo 100.00: dez processadas, cinco rejeitadas por INSUFFICIENT_FUNDS, saldo 0.00, version 11, onze lançamentos e 27 eventos.
- Cinquenta cópias do mesmo comando/Inbox foram distribuídas em lotes 17/17/16 pelos três processos: uma execução original, 49 replays, mesma transação e saldo 75.00 em todas as respostas. Uma BET, uma Inbox concluída e um débito persistidos.
- Ambos os testes financeiros usam PostgreSQL com migrations reais e barreira de row lock até os três processos iniciarem transações. A soma exata do ledger confirma os saldos finais.
- Dois processos publishers reivindicaram lotes disjuntos de cinco eventos enquanto dois outros registros estavam bloqueados. O teste inspeciona locked_by antes do envio e IDs tentados, para que deduplicação FIFO não mascare claims duplicados.
- Após liberar os bloqueios, os dois eventos restantes foram publicados. Os doze IDs chegaram ao LocalStack e não restaram eventos pendentes no schema exclusivo.
- Fixtures financeiras UUID removidas de forma restrita; fila e schema exclusivos do publisher removidos ao finalizar. Não houve alteração de código de produção nesta etapa.
- Documentação: [CONCURRENCY_TESTS.md](../testing/CONCURRENCY_TESTS.md), rastreabilidade e guias de mensageria atualizados. Naquela etapa, SIGKILL real e falha após aceite SQS ainda estavam pendentes.
- Validação final: TypeScript sem erros; suíte completa com 54 testes, 427 expectativas, zero falhas.

## Recuperação SQS e runtime real — etapa incremental

- Cinco testes reais PostgreSQL/LocalStack com filas FIFO UUID exclusivas.
- Falha após commit antes do ACK comprovou redelivery, uma Inbox, uma BET e um débito: saldo final 75.00 partindo de 100.00.
- Consumer contínuo recupera falha pré-commit e processa duplicata com novo deduplication ID SQS sem novo efeito financeiro.
- Poison message chegou à DLQ por redrive após duas tentativas, sem alterar a configuração das filas normais.
- Eventos reais recebidos coincidem com IDs persistidos. Runtime completo confirmou commit, ACK e quatro eventos de OPENING/BET publicados.
- Runtime testado em schema UUID exclusivo gerado pelo ORM, evitando capturar eventos alheios. Não comprova constraints adicionais das migrations. Saldo normalizado por Money para comparar 75 com 75.00.
- Limpeza restrita aos registros, filas e schema exclusivos desta suíte.
- TRACEABILITY foi corrigida naquela etapa: concorrência de dois publishers, imutabilidade SQL do ledger, SIGKILL real e três processos ainda estavam pendentes e foram tratados nas etapas posteriores.
- Skill de estratégia de testes orientou foco em efeito financeiro, redelivery e falhas, além do caminho de sucesso.
- Validação: TypeScript sem erros; 51 testes passaram, 371 expectativas, zero falhas. Comando `bun run test:messaging`; guia [MESSAGING_TESTS.md](../testing/MESSAGING_TESTS.md).

## Execução contínua de mensageria — etapa incremental

- Entrypoint inicia consumer e publisher; WORKERS_ENABLED=false desativa ambos. Importar AppModule em testes não inicia os loops automaticamente.
- Consumer recebe uma mensagem por vez, preserva ACK após commit e mantém erros sem DeleteMessage. Loop não termina por falha transitória: espera 1s antes de nova consulta. A visibilidade de 60s e a redrive policy da fila controlam redelivery/DLQ; não há classificação de erros permanentes implementada nesta etapa.
- Publisher busca até cinco eventos por ciclo, espera 1s entre ciclos e limita cada envio SQS a 5s. Claim/retry usam fork do EntityManager para isolar o contexto de background.
- SIGTERM/SIGINT interrompem long polling e esperas; shutdown aguarda processamento/publicação em andamento antes de fechar a aplicação. Não existe ainda deadline global de drain nem renovação de visibilidade para transações acima de 60s.
- Eventos são enviados para wager-events.fifo, separada da fila de comandos.
- Validação: TypeScript sem erros; 46 testes passaram, 347 expectativas. Novo teste comprova início único e drain da publicação em andamento. Fluxo contínuo completo com SQS real, crash pós-commit e DLQ permanece pendente de teste dedicado.

## Observabilidade — etapa incremental

- Adicionado prom-client com Registry isolado por aplicação e GET /metrics em formato Prometheus.
- Processamento instrumentado após resultado transacional: status por tentativa (sem replays), duplicatas, histograma de latência e códigos SQL de conflito de lock/serialização allowlisted.
- Logs JSON usam campos explícitos correlationId, messageId, transactionId, walletId e providerId; não serializam comandos, dinheiro, tokens, payloads ou erros SQL. IDs ausentes antes do commit aparecem como null.
- Logger de bootstrap Nest em JSON restringe eventos de framework a severidade/evento, suprimindo mensagens arbitrárias de exceções; diagnóstico específico fica nos eventos da aplicação.
- Worker de referências registra tentativas de retry; publisher aceita telemetria para retries agendados. Publisher ainda requer wiring de execução contínua e injeção do serviço na próxima etapa.
- Reconciliação exporta contador de divergências e evento JSON sem valores.
- Scrape calcula quantidade e idade do evento Outbox pendente mais antigo no PostgreSQL; SQS fornece contagem aproximada visível+inflight da DLQ, com timeout de 2s. Falha de coleta sinaliza dependency_up=0 e mantém o último gauge (não simula zero).
- Contadores são por processo e reiniciam junto com ele; gauges de banco/fila são estado compartilhado e não devem ser somados entre instâncias. Nenhum ID de usuário/wallet é label de métrica.
- Testado endpoint HTTP com PostgreSQL/LocalStack reais e teste de allowlist de logs, replays, retries e cardinalidade dos códigos de lock.
- Validação: 45 testes passaram, 343 expectativas, zero falhas; TypeScript sem erros.

## Reconciliação consistente — etapa incremental

- Implementado `POST /wallets/:walletId/reconciliation`, HTTP 200, UUID validado e wallet ausente em 404.
- PostgreSQL soma créditos menos débitos em NUMERIC, retorna string e Money calcula `storedBalance - calculatedBalance` sem converter dinheiro para number.
- Shared row lock (`FOR SHARE`) da wallet impede alteração financeira até terminar a soma do ledger na mesma transação. Reconciliações podem coexistir; movimentações podem esperar durante a consulta.
- Corrigido uso de SQL direto: `getConnection().execute` recebe explicitamente `em.getTransactionContext()`. A primeira prova concorrente detectou esgotamento de conexões ao omitir esse contexto.
- Resposta contém saldos, diferença, consistência, quantidade de entradas e incompatibilidades de moeda. Nenhuma correção automática.
- Divergências geram evento de log JSON sem valores financeiros e incrementam contador local consultável pelo serviço. Exportação de métricas e logging global continuam na etapa de observabilidade.
- Testados HTTP, wallet zerada, divergência injetada em wallet exclusiva de teste sem reparo, wallet ausente e cinco débitos concorrentes com reconciliações consistentes.
- Um timeout inicial deixou fixtures locais pendentes. O teste existente de publisher teve sua contabilidade ajustada para permitir eventos remanescentes; os dois eventos da operação continuam verificados por aggregateId. Não houve limpeza ampla do banco.
- Validação final: TypeScript sem erros; 44 testes passaram, 324 expectativas, zero falhas.

## Consultas HTTP e ledger paginado — etapa incremental

- Implementados GET de wallet, transação por UUID, transação por provider/identidade externa e ledger por wallet.
- Respostas explícitas não expõem hash de payload nem metadados internos de retry; valores financeiros são strings fixas em duas casas.
- Ledger paginado por `(created_at, id)` com cursor Base64URL versionado e vinculado à wallet, lookahead, limite 1–100 e padrão 50.
- Âncora e timestamps são comparados no PostgreSQL para evitar perda de precisão temporal.
- Teste HTTP real: cinco lançamentos no mesmo timestamp, páginas 2/2/1, nenhuma omissão ou duplicação; transação mostra saldo histórico 90.00 enquanto wallet mostra saldo atual 60.00.
- Testados isolamento por provider, cursor cruzado/malformado, limites inválidos, recursos ausentes, UUID inválido e ledger vazio.
- Limitação: paginação representa visão viva, não snapshot congelado; timestamps retroativos podem exigir reiniciar a consulta. Autorização continua no-op conforme desafio.
- Validação: TypeScript sem erros; 42 testes, 295 expectativas, zero falhas.

## Criação de wallet e OPENING atômico — etapa incremental

- Implementado `POST /wallets` com UUID e saldo inicial obrigatórios, valor decimal em string e validação estrita.
- `CreateWalletUseCase` insere wallet com versão 1; saldo positivo gera transação interna OPENING processada, ledger CREDIT de zero ao saldo inicial e dois eventos Outbox na mesma transação SQL.
- Saldo zero não gera OPENING, ledger ou evento de alteração de saldo.
- OPENING possui factory interna explícita; a submissão externa continua proibida.
- A constraint `wallets_player_currency_unique` é mapeada especificamente para `WALLET_ALREADY_EXISTS`/HTTP 409; outras violações não são mascaradas como duplicidade de wallet.
- Testada criação concorrente em PostgreSQL, com uma criação e um conflito.
- Falha injetada após flush de wallet, OPENING, ledger e primeiro evento comprovou rollback da unidade financeira.
- Teste HTTP real com Nest: 201 na criação, 409 na duplicata, 400 para UUID inválido ou saldo ausente. Aplicação e dados de teste encerrados/limpos ao final.
- Validação: TypeScript sem erros; 41 testes passaram, 265 expectativas, zero falhas.

## Reversões concorrentes e saldo insuficiente — etapa incremental

- Adicionados testes de REFUND e ROLLBACK com duas solicitações distintas em paralelo para a mesma referência, usando transações PostgreSQL independentes no mesmo processo.
- Cada disputa produziu uma operação PROCESSED, uma REJECTED com `REFERENCE_ALREADY_REVERSED`, um único lançamento de reversão e eventos de processamento/rejeição correspondentes.
- Replays mantiveram identidade e estado original das duas operações.
- Testado WIN de `50.00`, BET de `40.00` e ROLLBACK do WIN: saldo disponível `10.00`, rejeição `REVERSAL_WOULD_CREATE_NEGATIVE_BALANCE`, Inbox concluída e nenhum ledger de reversão.
- Depois de novo WIN de `40.00`, o replay da rejeição manteve o saldo observado `10.00`; nova operação com nova identidade pôde reverter a referência. Uma rejeição não consome a possibilidade de reversão.
- Os três cenários começam com saldo zero e verificam saldo armazenado igual à soma exata do ledger usando Money.
- Verificação: TypeScript sem erros; 36 testes, 237 expectativas, zero falhas.
- Ainda falta a prova com três processos independentes e os cenários de falha do broker.

## Rejeições auditáveis de referências — etapa incremental

- Referências incompatíveis agora persistem `REJECTED`, saldo observado, Inbox concluída e evento `WagerTransactionRejected` na mesma transação SQL.
- Moeda diferente retorna `CURRENCY_MISMATCH`; incompatibilidade de identidade, rodada, estado, tipo ou valor de reversão retorna `INVALID_REFERENCE`.
- `WIN` com referência exige BET processada da mesma moeda; o prêmio pode ter valor diferente da aposta e múltiplos WINs não são tratados como reversões duplicadas.
- O teste de integração cobre oito cenários inválidos e seus replays. Os registros de referência são fixtures de banco; esta prova verifica rejeições e ausência de novos efeitos financeiros, não reconciliação de um histórico completo.
- Verificado: saldo `100.00`, versão `1`, zero lançamentos novos e zero eventos de alteração de saldo.
- TypeScript sem erros; suíte completa: 33 testes, 191 expectativas, zero falhas.

## Blindagem de pendências e reversões — etapa incremental

- Separado `execute` (entrada/replay) de `retryPendingReference` (worker).
- Replay de pendência não incrementa tentativas nem gera novos eventos.
- Depois do lock da wallet, a transação pendente é consultada novamente com `refresh: true`; workers que aguardaram o lock observam o estado confirmado pelo primeiro worker.
- Busca de reversão anterior considera somente transações `PROCESSED`, excluindo a própria operação ainda pendente e rejeições anteriores.
- Teste real com três workers concorrentes: exatamente dois lançamentos no ciclo BET/refund, um evento de conclusão do refund e saldo final `100.00`.
- Esta evidência usa três workers no mesmo processo; o teste com três processos independentes permanece pendente.

## 2026-10-03 — Baseline do projeto

### Objetivo

Estabelecer a documentação inicial e o controle de rastreabilidade antes da implementação.

### Estado observado

- Repositório na branch `main`.
- Branch sincronizada com `origin/main`.
- Nenhuma alteração local antes desta fase.
- Projeto contém apenas o `README.md` do desafio.

### Alterações realizadas

- Criado `ARCHITECTURE.md`.
- Criado `DECISIONS.md`.
- Criado este `IMPLEMENTATION_LOG.md`.
- Criado `CHANGELOG.md`.
- Criado `TRACEABILITY.md`.

### Validação

Ainda não há código, dependências, migrations ou testes para executar.

### Próxima fase

Definir o bootstrap técnico mínimo e registrar a decisão de estrutura modular antes de adicionar dependências.

## 2026-10-03 — Domínio inicial: Money e Wallet

### Objetivo

Implementar o primeiro núcleo financeiro sem dependência de NestJS, PostgreSQL ou SQS.

### Alterações realizadas

- Criado `Money` com `decimal.js`.
- Adicionada validação de moeda e string decimal.
- Adicionada serialização fixa em duas casas.
- Criada `Wallet` com saldo encapsulado.
- Criados movimentos `debit` e `credit`.
- Adicionado retorno explícito de `balanceBefore` e `balanceAfter` para futura criação do ledger.
- Criados testes unitários iniciais.

### Invariantes cobertas

- dinheiro sem `number`;
- operações entre moedas diferentes rejeitadas;
- saldo inicial negativo rejeitado;
- débito sem saldo rejeitado;
- saldo não é alterado quando um débito falha;
- versão começa em `1` e incrementa quando o saldo muda;
- `Money` permanece imutável.

### Validação

- `bun install`: bloqueado porque `bun` não está disponível no ambiente.
- `bun test`: não executado por ausência de `bun`.
- `bunx tsc --noEmit`: não executado por ausência de `bunx`.
- Node disponível: `v26.5.0`.
- npm disponível: `11.17.0`.

### Decisão operacional

Não substituí Bun por npm para validar silenciosamente, pois o runtime/package manager é requisito explícito do desafio. A validação será repetida assim que Bun estiver disponível.

### Validação posterior

- Bun instalado: `1.4.2`.
- `bun install`: concluído; lockfile criado.
- `bun test`: 9 testes passaram, 0 falharam.
- `bun x tsc --noEmit`: concluído sem erros.
- Uma rodada inicial encontrou quatro falhas de domínio; elas foram corrigidas antes de considerar a fase concluída.

## 2026-10-03 — Ledger imutável

### Objetivo

Representar cada alteração financeira como um lançamento auditável e aritmeticamente verificável.

### Alterações realizadas

- Criado `WalletLedgerEntry`.
- Adicionada validação de identidade, valor positivo, moeda e saldo não negativo.
- Adicionada validação `balanceBefore ± money = balanceAfter`.
- Adicionada reidratação sem métodos de transição.
- Criados testes de débito, crédito, inconsistência, moeda e imutabilidade.

### Próxima fase

Integrar `Wallet` e `WalletLedgerEntry` dentro de uma unidade de aplicação, mantendo a criação do ledger na mesma transação que altera o saldo.

### Validação

- `bun test`: 14 testes passaram, 0 falharam.
- `bun x tsc --noEmit`: concluído sem erros.
- O teste de imutabilidade encontrou que `readonly Date` ainda permitia mutação interna; foi corrigido com campo privado e cópia defensiva.

## 2026-10-03 — Caso de uso de movimento da wallet

### Objetivo

Criar a primeira fronteira de aplicação que coordena alteração de saldo e criação do ledger dentro de uma unidade transacional.

### Alterações realizadas

- Criados ports `WalletRepository`, `LedgerRepository`, `IdGenerator` e `UnitOfWork`.
- Criado `ApplyWalletMovementUseCase`.
- O repositório de wallet exige uma operação `findByIdForUpdate`.
- O caso de uso aplica o movimento no aggregate antes de criar o ledger.
- O ledger recebe os valores calculados pelo aggregate, sem recalcular o saldo.
- Criados fakes apenas para teste unitário da coordenação.

### Validação

- `bun test`: 16 testes passaram, 0 falharam.
- `bun x tsc --noEmit`: concluído sem erros.

### Próxima fase

Projetar migrations e adapters MikroORM para que wallet e ledger sejam persistidos na mesma transação SQL, com constraints no banco.

## 2026-10-03 — Bootstrap de persistência

### Alterações realizadas

- Adicionados `@mikro-orm/core`, `@mikro-orm/postgresql`, `@mikro-orm/migrations`, `@mikro-orm/cli` e `pg`.
- Criada configuração `mikro-orm.config.ts`.
- Criada migration reversível para `wallets`, `wager_transactions` e `wallet_ledger_entries`.
- Adicionadas constraints de saldo, moeda, unicidade, status, direção e aritmética do ledger.
- Criado `docker-compose.yml` para PostgreSQL local.
- Adicionado `.env.example`.
- Adicionados scripts de migration ao `package.json`.

### Validação

- `bun x tsc --noEmit`: concluído sem erros.
- `bun test`: 16 testes passaram, 0 falharam.
- Migration contra PostgreSQL real: bloqueada; Docker, `psql` e `pg_isready` não estão disponíveis neste ambiente.

### Limitação atual

A sintaxe SQL e as constraints ainda precisam ser exercitadas em um PostgreSQL real antes de considerar a migration pronta para integração contínua.

### Validação posterior

- Docker Desktop iniciado e daemon saudável.
- PostgreSQL `16-alpine` subido pelo Compose.
- `Migration20261003120000` aplicada com sucesso.
- Tabelas confirmadas: `wallets`, `wager_transactions`, `wallet_ledger_entries` e `mikro_orm_migrations`.
- Migration registrada na tabela de controle.
- 23 constraints financeiras e relacionais confirmadas via `pg_constraint`.

### Limitação resolvida

A validação que dependia de PostgreSQL real foi concluída. A próxima validação deverá exercitar inserts válidos e inválidos, além dos adapters MikroORM.

## 2026-10-03 — Adapters MikroORM e integração real

### Alterações realizadas

- Adicionadas entidades schema-first compatíveis com MikroORM 7.
- Criado `MikroOrmUnitOfWork` usando `EntityManager.transactional()`.
- Criado `MikroOrmWalletRepository` com `LockMode.PESSIMISTIC_WRITE`.
- Criado `MikroOrmLedgerRepository`.
- Criado mapper de persistência para reidratar `Wallet` com `Money`.
- Adicionado teste de integração real contra PostgreSQL.

### Falha encontrada e corrigida

O primeiro setup tentou inserir a transação antes da wallet porque as entidades não tinham relações ORM declaradas. O teste passou a confirmar a wallet antes de inserir a transação, tornando explícita a ordem exigida pela foreign key.

### Validação

- `bun test`: 17 testes passaram, 0 falharam.
- `bun x tsc --noEmit`: concluído sem erros.
- PostgreSQL real: wallet debitada de `100.00` para `75.00` e um ledger persistido.

### Próxima fase

Executar concorrência real com duas transações disputando a mesma wallet e comprovar o cenário obrigatório de duas apostas de `80.00` sobre saldo `100.00`.

### Validação posterior

- Teste executado com duas transações PostgreSQL concorrentes.
- Resultado: uma operação processada e uma rejeitada por saldo insuficiente.
- Saldo final: `20.00`.
- Ledger final: exatamente um lançamento de `80.00`.
- Versão final da wallet: `2`.
- Uma tentativa de consulta pelo EntityManager global foi rejeitada pelo MikroORM e corrigida para usar `fork()`, mantendo isolamento de contexto.
- `bun test`: 18 testes passaram, 0 falharam.
- `bun x tsc --noEmit`: concluído sem erros.

### Próxima fase

Implementar idempotência persistente e o agregado `WagerTransaction`, incluindo payload hash, replay original e conflito de chave.

### Validação posterior

- Criado o agregado `WagerTransaction` com estados, transições e códigos de falha.
- Implementado `ProcessBetUseCase`.
- Persistida a resposta original (`response_balance_amount` e `response_balance_currency`).
- Replay idêntico retorna o mesmo `transactionId`, status e saldo observado.
- Mesmo idempotency key com hash diferente gera `IDEMPOTENCY_CONFLICT`.
- Foreign key do ledger exigiu flush da transação antes do ledger, ainda dentro da mesma transação SQL.
- `bun test`: 24 testes passaram, 0 falharam.
- `bun x tsc --noEmit`: concluído sem erros.
- PostgreSQL real: idempotência e ausência de ledger duplicado validados.

### Próxima fase

Implementar eventos de domínio e Transactional Outbox na mesma unidade transacional da operação financeira.

### Validação posterior

- Criados envelopes versionados e subclasses concretas de eventos.
- Criados `WagerTransactionProcessed`, `WagerTransactionRejected` e `WalletBalanceChanged`.
- Criado `OutboxMessage` com retry/backoff e estado de publicação.
- Criada tabela `outbox_messages` com índice de pendências.
- Outbox persistida na mesma transação da wallet, wager transaction e ledger.
- Uma BET processada gera exatamente dois eventos.
- Replay idempotente não gera novos eventos.
- `bun test`: 24 testes passaram, 0 falharam.
- `bun x tsc --noEmit`: concluído sem erros.

### Próxima fase

Implementar publisher concorrente da Outbox com `FOR UPDATE SKIP LOCKED`, reserva de mensagens e confirmação após publicação.

### Validação posterior

- Criado `PublishOutboxUseCase`.
- Publisher reserva mensagens antes de chamar o broker.
- Reserva usa `LockMode.PESSIMISTIC_PARTIAL_WRITE`, equivalente a `FOR UPDATE SKIP LOCKED`.
- `published_at` só é preenchido depois do sucesso do publisher.
- Segunda execução não reclama mensagens já publicadas.
- Lease de 60 segundos permite recuperar locks abandonados por processo morto.

## 2026-10-03 — Consumer SQS e ambiente local

### Alterações realizadas

- Adicionado hash SHA-256 de JSON canônico com ordenação recursiva de chaves.
- Criado `SqsWagerTransactionConsumer` usando o mesmo `ProcessBetUseCase` da aplicação.
- O consumer registra Inbox com `(consumerName, messageId)` e só executa `DeleteMessage` depois do retorno do caso de uso.
- Falhas deixam a mensagem para redelivery; a fila local usa DLQ após cinco entregas.
- Separadas fila de entrada e fila de eventos do Outbox para evitar loop de mensageria.
- Fixada a imagem LocalStack em `3.8.1` porque `latest` exigia `LOCALSTACK_AUTH_TOKEN`.

### Validação

- LocalStack Community `3.8.1`: container saudável.
- Filas locais confirmadas: entrada, DLQ e eventos.
- Redrive policy confirmada via `GetQueueAttributes`.
- `bun x tsc --noEmit`: concluído sem erros.
- `bun test`: 30 testes passaram, 0 falharam, 100 expectativas.

### Limitação explícita

- O consumer atual está conectado ao caso de uso de `BET`. Outros tipos (`WIN`, `REFUND`, `ROLLBACK`) permanecem no modelo de domínio e exigem casos de uso próprios antes de serem habilitados no worker.

## 2026-10-03 — HTTP API e bootstrap NestJS

### Alterações realizadas

- Adicionado bootstrap NestJS com `ValidationPipe` estrito.
- Criado `POST /wagering/transactions` reutilizando o `ProcessBetUseCase`.
- Adicionados DTOs com validação de UUID, enum, moeda e campos obrigatórios.
- Criado filtro HTTP para erros de domínio e mapeamento consistente de status.
- Adicionado `NoopAuthGuard` como ponto explícito para futura validação JWT.
- Criados `/health/live` e `/health/ready`; readiness verifica PostgreSQL e SQS.
- Ativada emissão de metadata de decorators exigida pela injeção do NestJS.

### Falha encontrada e corrigida

O primeiro boot falhou porque os adapters MikroORM não tinham metadata de injeção. Os providers foram anotados com `@Injectable()` e o TypeScript passou a emitir decorator metadata.

Também foi corrigida a ordem do `ProcessBetUseCase`: a wallet é bloqueada e validada antes da inserção de `wager_transactions`, evitando que wallet inexistente gere erro de foreign key 500.

### Validação

- NestJS iniciou com PostgreSQL e LocalStack reais.
- `GET /health/live`: HTTP 200.
- `GET /health/ready`: HTTP 200 com `postgres=up` e `sqs=up`.
- Payload com UUID inválido: HTTP 400.
- Wallet inexistente: HTTP 404 com `WALLET_NOT_FOUND`.
- `bun x tsc --noEmit`: concluído sem erros.
- `bun test`: 30 testes passaram, 0 falharam.

## 2026-10-03 — Ciclo completo e referências fora de ordem

### Alterações realizadas

- Generalizado o caso de uso para `BET`, `WIN`, `LOSS`, `REFUND` e `ROLLBACK`.
- Adicionadas consultas por transação externa e por referência/tipo de reversão.
- Implementadas regras de mesma wallet, player, provider, rodada e moeda.
- Implementadas direções de ledger para créditos e reversões.
- Impedida a segunda reversão da mesma referência pelo mesmo tipo.
- Adicionado evento `WagerTransactionPendingReference`.
- Criado `PendingReferenceWorker` com `@Cron` a cada cinco segundos.
- Adicionada migration `Migration20261003160000` com contador e próximo horário de retry.
- Backoff limitado a 60 segundos e máximo de cinco tentativas.

### Validação

- `WIN` processado com crédito.
- `REFUND` processado uma vez; duplicata rejeitada.
- `ROLLBACK` processado com direção inversa.
- `REFUND` antes da `BET` persistido como `PENDING_REFERENCE` e concluído pelo worker.
- `bun x mikro-orm migration:up`: migration aplicada no PostgreSQL real.
- `bun x tsc --noEmit`: concluído sem erros.
- `bun test`: 32 testes passaram, 0 falharam, 111 expectativas.
- Teste de integração confirmou que mensagem com lease expirado é reclamada por outro publisher.
- `bun test`: 25 testes passaram, 0 falharam.
- `bun x tsc --noEmit`: concluído sem erros.

### Próxima fase

Adicionar o broker SQS via LocalStack e o Inbox persistente, mantendo ACK somente após commit e deduplicação por `(consumer_name, message_id)`.

### Correção de interpretação

Uma execução interrompida após o claim não deve ser chamada apenas de "resíduo". O comportamento correto é recuperação por lease expirado. Uma queda depois do publish e antes de `published_at` ainda pode causar publicação duplicada; isso será coberto pela idempotência do consumidor Inbox.
