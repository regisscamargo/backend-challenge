# Execução contínua

`bun start` inicia HTTP, consumer SQS e publisher Outbox. `WORKERS_ENABLED=false`
desliga os dois loops de mensageria (não o cron de referências pendentes).

O consumer recebe uma mensagem por vez. O caso de uso confirma a transação SQL
antes de DeleteMessage. Se houver erro, não há ACK: a mensagem volta após 60s;
a redrive policy configurada na fila determina sua transferência para a DLQ.
Falhas de polling/processamento incrementam retries{source="sqs"}; esse contador
inclui falhas de consulta e não equivale ao número exato de redeliveries.

O publisher faz claim de até cinco eventos com SKIP LOCKED e lease de 60s.
Cada envio tem timeout de 5s. Só após resposta SQS marca published_at.
Falha entre envio e marcação pode gerar duplicata: consumidores dos eventos
também precisam de idempotência persistente. Deduplicação FIFO não substitui isso.
O destino é wager-events.fifo, nunca a fila de comandos.

SIGTERM/SIGINT abortam long polling e acordam esperas. Trabalho em andamento
termina antes do fechamento dos recursos. Se o processo for morto sem drain,
mensagens sem ACK retornam por visibilidade e claims expiram pelo lease.

## Limites atuais e próxima validação

- Não há heartbeat de visibilidade: processamento acima de 60s pode ser entregue
  novamente. Idempotência protege o efeito financeiro, não elimina contenção.
- Não há deadline global de shutdown ou timeout SQL específico do runtime.
- Mensagens inválidas ainda usam redrive, sem classificação antecipada para DLQ.
- Lease não é renovado; chamadas SQL lentas também podem excedê-lo.
- `bun --env-file=.env run test:messaging` cobre redelivery pós-commit/pré-ACK, retry transitório,
  duplicata explícita, redrive FIFO para DLQ e runtime contínuo com eventos reais.
  Ver [../testing/MESSAGING_TESTS.md](../testing/MESSAGING_TESTS.md) para evidências e limites. A concorrência multiprocessos
  é coberta por `test:concurrency` ([CONCURRENCY_TESTS.md](../testing/CONCURRENCY_TESTS.md)). `test:recovery` cobre
  SIGKILL pós-commit e pós-envio ([CRASH_RECOVERY_TESTS.md](../testing/CRASH_RECOVERY_TESTS.md)).
