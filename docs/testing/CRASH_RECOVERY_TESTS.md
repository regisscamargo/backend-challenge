# Recuperação após SIGKILL

Execute `bun --env-file=.env run test:recovery` com PostgreSQL migrado e LocalStack disponíveis.
Os testes usam processos Bun distintos, mensagens SQS reais e consultas ao banco.
O coordenador envia SIGKILL ao handle do processo criado para o teste e verifica
o sinal de término. A recuperação ocorre em outro PID, com ORM e pool novos.

| Fronteira | Estado quando o processo morre | Recuperação comprovada |
|---|---|---|
| Commit financeiro → DeleteMessage | BET, débito, Inbox e Outbox confirmados; mensagem permanece na fila | Nova entrega retorna resultado original e conclui o ACK |
| SendMessage aceito → published_at | Evento recebido no SQS; Outbox pendente com lease do processo morto | Após expirar o lease, novo processo envia o mesmo eventId e marca a publicação |

## Consumer: efeito financeiro preservado

A wallet começa com 100.00 e a BET vale 25.00. O worker usa o consumer de produção
com um wrapper de teste que pausa depois de ProcessBetUseCase.execute concluir.
Nessa fronteira o commit já terminou e DeleteMessage ainda não foi chamado.
O coordenador verifica a persistência e mata o processo com SIGKILL.

O banco apresenta o mesmo estado antes da morte, depois da morte e depois da
recuperação: saldo 75.00, version 2, uma BET, um débito, uma Inbox concluída e
quatro eventos incluindo a abertura. O novo processo retorna o mesmo transactionId,
idempotentReplay=true e saldo 75.00. A contagem de mensagens visíveis mais mensagens
em processamento cai de uma para zero depois de seu ACK.

Isso exercita a janela real entre a transação SQL e o ACK do SQS. Não há estado
compartilhado em memória entre o processo morto e o processo de recuperação.

## Publisher: evento preservado e envio repetido

Uma Outbox exclusiva contém um evento RecoveryProbe. O worker usa o publisher
de produção e pausa depois que o adapter SQS recebe a resposta de SendMessage,
antes de markPublished. O teste recebe e confirma essa mensagem na fila e verifica
published_at nulo, locked_at preenchido e locked_by pertencente ao claim.
Em seguida, encerra o publisher com SIGKILL.

Outro claim imediatamente após a morte não obtém o evento: o lease ainda vale.
O teste espera a expiração real de um lease de 5s, sem editar locked_at nem
adiantar o relógio. Um novo processo reivindica o registro, recebe outro aceite
de SendMessage para o mesmo eventId e grava published_at. O lock é removido e
continua existindo apenas um registro na Outbox.

O contador attempts permanece zero porque o SIGKILL não executa o catch que
agenda retries. Esse contador mede falhas capturadas, não todas as tentativas
de envio. Para medir reenvios após morte seria necessário instrumentar claims/envios.

O teste prova dois envios aceitos para o mesmo ID. A fila FIFO pode suprimir a
segunda entrega dentro da janela de deduplicação. Portanto o teste não prova
duas entregas ao consumidor de eventos nem oferece garantia exactly-once.
Consumidores dos eventos precisam de idempotência persistente para reenvios
fora dessa janela ou em outras condições de redelivery.

## Isolamento e configuração

- Consumer usa o schema principal com migrations reais, wallet UUID e Inbox exclusiva.
- Publisher usa schema UUID exclusivo gerado pelo ORM; o teste não cobre constraints financeiras extras das migrations.
- Filas FIFO UUID exclusivas são removidas ao final. Os registros financeiros removidos são somente os desta suíte.
- A visibilidade do consumer de teste é 1s e o lease do publisher é 5s. O runtime normal usa 60s para ambos.
- Os wrappers de pausa ficam em test/support; a implementação de produção não contém mecanismos de crash de teste.

O teardown encerra filhos remanescentes e remove fixtures, fila e schema de teste.
Essa limpeza é restrita e remove apenas dados descartáveis da própria execução.
Falha na máquina PostgreSQL, failover do banco, deadline de shutdown e renovação
de visibilidade/lease para operações longas permanecem fora destas duas provas.

Para apresentar: o banco confirma o dinheiro antes do ACK. Se o processo morrer,
o SQS entrega de novo e a identidade persistida impede outro débito. Na saída,
um evento com publicação incerta é reenviado para preservar sua entrega; seu
eventId permite ao consumidor reconhecer a repetição.
