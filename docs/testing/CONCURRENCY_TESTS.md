# Concorrência entre processos

Execute `bun --env-file=.env run test:concurrency` com PostgreSQL migrado e LocalStack disponíveis.
A suíte cria processos Bun reais, cada um com seu próprio ORM, pool e memória.
Os testes verificam PIDs diferentes e saída normal dos processos.

## Disputa pelo saldo disponível

Uma wallet começa com 100.00. Três processos recebem cinco apostas distintas
de 10.00 cada. O coordenador mantém a wallet bloqueada até que os três filhos
tenham iniciado uma transação SQL, então libera a disputa.

Resultado exigido: dez apostas PROCESSED, cinco REJECTED com INSUFFICIENT_FUNDS,
saldo 0.00, version 11 e onze lançamentos (OPENING mais dez débitos).
Os 27 eventos correspondem a dois de abertura, vinte das apostas processadas
e cinco de rejeição. A soma exata do ledger reconstrói o saldo final; nenhum
lançamento pode apresentar balance_after negativo.

O teste usa o schema principal com as migrations reais e fixtures UUID próprias.
Isso exercita locks e constraints reais entre conexões de processos diferentes.

## Cinquenta cópias da mesma operação

Os três processos recebem 17, 17 e 16 cópias do mesmo comando, incluindo
messageId, consumerName, providerId, idempotencyKey e payloadHash iguais.
Cada processo submete seu lote com Promise.all; o pool limita as conexões SQL.

Resultado exigido: cinquenta respostas PROCESSED com mesmo transactionId e saldo
75.00; uma execução original e 49 replays. Persistem uma BET, uma Inbox concluída,
um débito de 25.00 e dois eventos novos. Incluindo a abertura: dois lançamentos,
quatro eventos e version 2.

As chamadas entram diretamente no caso de uso. Isso força a disputa no banco
sem a serialização por MessageGroupId do SQS FIFO. Redelivery e ACK no transporte
real são exercitados separadamente por test:messaging. Este cenário usa o mesmo
messageId; não prova cinquenta envelopes com messageIds distintos.

## Dois publishers e registros bloqueados

Uma Outbox exclusiva começa com doze eventos. O coordenador bloqueia os dois
mais antigos em uma transação e inicia dois processos publishers.

Cada publisher faz claim de cinco eventos e pausa antes do primeiro envio.
Nesse ponto, o teste verifica dez registros com dois locked_by distintos e
nenhum dos dois IDs bloqueados. A chegada dos dois processos a essa barreira
demonstra que os registros bloqueados foram ignorados por SKIP LOCKED.

Ambos publicam suas cinco mensagens no LocalStack. As listas de IDs tentados
são disjuntas: a deduplicação FIFO não pode mascarar um claim duplicado. Ao
liberar os dois registros restantes, outro ciclo os publica. Os doze IDs
recebidos coincidem com os eventos persistidos, sem published_at nulo restante.

## Wallets distintas

Doze wallets com saldo 100.00 recebem uma BET de 10.00, distribuídas entre três
processos. Todas as operações são iniciadas pelo mesmo mecanismo de barreira dos
demais testes. Os doze IDs de transação são distintos, todas as respostas são
PROCESSED e cada wallet termina em 90.00, com OPENING e DEBIT no ledger.
Essa prova detectaria um lock global funcionalmente correto, mas não mede sozinha
o ganho de throughput; a medição quantitativa pertence ao teste opcional de carga.

O schema desse teste é exclusivo, gerado pelo ORM; serve para testar claims,
leases e publicação. As constraints financeiras extras das migrations são
exercitadas pelos dois testes anteriores, no schema migrado.

## Limpeza e limites

O teardown remove apenas registros e filas de teste identificados por UUID.
O schema exclusivo dos publishers é removido ao final. Processos filhos ainda
ativos em caso de falha são encerrados pelo handle criado pelo próprio teste.

Esses cenários comprovam correção sob as disputas descritas. Não medem capacidade
de produção ou latência p99 e não provam ausência de duplicação de entrega após
falha entre o aceite do SQS e a marcação de published_at. A garantia da Outbox
continua sendo at-least-once. Morte real pós-commit/pré-ACK e recuperação após
aceite SQS antes de published_at são cobertas por [CRASH_RECOVERY_TESTS.md](CRASH_RECOVERY_TESTS.md).

Para apresentar: explique qual recurso é disputado, qual regra o PostgreSQL
impõe e mostre saldo, ledger e eventos que comprovam o resultado. Um mutex em
memória não coordenaria os três processos deste teste.
