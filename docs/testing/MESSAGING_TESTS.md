# Provas de recuperação da mensageria

Execute PostgreSQL/LocalStack locais e migrations antes de `bun --env-file=.env run test:messaging`.
A suíte falha se as dependências não estiverem disponíveis; não simula sucesso.

| Cenário | Falha ou estímulo | Evidência |
|---|---|---|
| Commit sem ACK | Wrapper lança exceção depois de execute concluir | Redelivery real; saldo 75.00; uma BET, um débito e uma Inbox |
| Retry transitório | Primeira tentativa falha antes de execute | Loop continua e segunda tentativa processa |
| Duplicata explícita | Mesmo envelope com novo MessageDeduplicationId SQS | Entrega realmente ocorre; efeito financeiro continua único |
| DLQ | JSON inválido; redrive com maxReceiveCount=2 | Duas falhas; corpo original recebido na DLQ |
| Eventos | Adapter publica eventos de saldo já persistidos | IDs recebidos coincidem com IDs da Outbox |
| Runtime contínuo | Consumer e publisher reais executam juntos | Uma BET, dois ledgers incluindo OPENING, quatro eventos publicados, entrada sem mensagem restante |

## Por que isso importa

O banco não participa de uma transação distribuída com o ACK do SQS. Se o
processo falhar entre commit e ACK, a entrega volta. A idempotência persistente
reconhece a operação já concluída e impede outro débito. O ACK pode então ocorrer
sem alterar novamente o saldo. Isso é entrega at-least-once com efeito financeiro
único nos cenários testados, não garantia de entrega exactly-once.

A Outbox elimina a janela de perda entre commit financeiro e criação do evento.
Ainda pode haver publicação duplicada entre o aceite do SQS e published_at.
Esta janela possui teste SIGKILL separado em [CRASH_RECOVERY_TESTS.md](CRASH_RECOVERY_TESTS.md).

## Isolamento e limpeza

Cada teste cria filas FIFO UUID exclusivas. Os testes no schema principal usam
wallets UUID próprias e removem somente seus registros e sua Inbox exclusiva.
O teste do runtime cria e remove um schema PostgreSQL UUID exclusivo para impedir
que o publisher capture eventos não pertencentes ao teste. Esse schema usa o
gerador do ORM, não as migrations: não é evidência das constraints SQL extras.
As migrations permanecem cobertas pelos testes de persistência existentes.
As filas criadas pela suíte são removidas ao terminar, inclusive a DLQ de teste.

Visibilidade de 1s acelera o teste; o runtime normal usa 60s. A DLQ de teste usa
duas tentativas; a fila local normal usa cinco. LocalStack não substitui uma
validação final contra AWS nem comprova limites de throughput em produção.

## O que falta provar

- Renovação de visibilidade/lease e deadline de shutdown em trabalho longo.

Três processos disputando saldo, cinquenta cópias concorrentes e dois publishers
simultâneos já possuem provas próprias: ver [CONCURRENCY_TESTS.md](CONCURRENCY_TESTS.md).
SIGKILL após commit e após aceite SQS também possuem provas próprias:
ver [CRASH_RECOVERY_TESTS.md](CRASH_RECOVERY_TESTS.md) e `bun --env-file=.env run test:recovery`.

Para apresentar: mostre primeiro o saldo/ledger, depois a fronteira commit/ACK,
e por último explique por que aceitar redelivery é necessário para não perder
operações — desde que o efeito financeiro seja protegido pela idempotência.
