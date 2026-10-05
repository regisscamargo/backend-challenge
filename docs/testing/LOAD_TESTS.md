# Teste de carga local

## Ambiente e cenário

- Ambiente: MacBook Air, 10 CPUs lógicas, 16 GiB RAM; API, PostgreSQL e LocalStack via Docker Compose.
- Caminho exercitado: `POST /wagering/transactions` para uma única hot wallet; publicação assíncrona das notificações pelo Outbox para a fila FIFO local.
- Carga: 100 requests com concorrência 5, seguidos de 300 com concorrência 15; BET único de R$ 0,01 por request.
- Erros HTTP: 0/400; conflitos de lock: 0 observados; saldo final R$ 9.996,00 e versão 401, ambos esperados.
- Em todas as amostras: 400/400 POSTs com sucesso, sem erros HTTP nem conflitos de lock observados; saldo final R$ 9.996,00 e versão 401, ambos esperados.

## Resultados comparativos — 2026-10-03

| Publisher | Throughput HTTP observado | Latência HTTP p95 | Outbox pendente inicial | Tempo até drenar |
|---|---:|---:|---:|---:|
| Baseline: 5 mensagens por ciclo, pausa de 1 s | ~399,60 req/s | 40,29 ms | 797 | 164,226 s |
| Drenagem imediata, envio individual serial (duas amostras) | 64,32–128,53 req/s | 167,42–285,89 ms | 610 / 746 | 5,209 / 4,984 s |
| Lotes SQS de até 10 agregados distintos (amostra final) | 167,79 req/s | 104,00 ms | 357 | 3,579 s |

Na amostra final, p50 foi 70,46 ms, p99 134,10 ms e máximo 303,33 ms. O Outbox chegou a zero pendente e lag zero. Os artefatos relacionais com provider exclusivo do ensaio foram removidos pelo cleanup direcionado.

## Repetição de validação — 2026-10-04

- Run ID: `550491c8-019f-4fda-9084-35cde7ddc4c2`.
- Resultado: 400/400 respostas de sucesso, zero erros HTTP; saldo `9996.00` e versão `401`, ambos iguais ao esperado.
- Throughput observado: `165.91 req/s`; p50 `61.98 ms`, p95 `113.44 ms`, p99 `610.59 ms`, máximo `616.58 ms`.
- Outbox: 400 pendentes no início da drenagem, drenada em `3.322 s`; lag final reportado como zero.
- O script concluiu com sucesso e executou cleanup direcionado. As mensagens já publicadas permanecem na fila FIFO local; a fila não foi purgada.
- Esta repetição teve cauda p99/max bem maior que a amostra anterior. Com apenas uma rodada adicional, não atribuímos causa; a variação reforça que as amostras curtas não definem SLO nem capacidade de produção.

## Repetição atual — 2026-10-04

- Run ID: `2963f84d-1663-428d-80ae-2045e18bb3f0`.
- Resultado: 400/400 respostas de sucesso, zero erros HTTP; saldo `9996.00` e versão `401`, iguais ao esperado.
- Throughput observado: `171.97 req/s`; p50 `61.49 ms`, p95 `139.82 ms`, p99 `176.89 ms`, máximo `196.87 ms`.
- Outbox: 348 pendentes no início da drenagem; drenada em `4.324 s`, lag reportado zero.
- Cleanup direcionado concluiu sem erro. As mensagens publicadas permanecem na fila FIFO local, que não foi purgada.
- Esta é outra amostra curta e local; a variação entre rodadas não permite inferir capacidade de produção ou SLO.

## Interpretação e limites

O caminho síncrono HTTP/PostgreSQL concluiu as 400 operações sem erro e preservou saldo e versão. A mudança mais recente reduziu a drenagem observada de 164,2 s para 3,58 s (aproximadamente 46× nesta comparação). O envio agrupado também recuperou parte da latência perdida pela drenagem serial imediata: throughput observado de ~168 req/s e p95 de 104 ms, contra 64–129 req/s e p95 de 167–286 ms nas amostras seriais.

O ganho veio de remover a pausa fixa, limitar claims ao evento mais antigo de cada agregado, enviar até dez agregados distintos em `SendMessageBatch` e agrupar a confirmação SQL dos ACKs bem-sucedidos. A ordenação por wallet usa `walletVersion`; para cada grupo, o FIFO mantém a ordem enviada no batch conforme a [documentação da API SQS](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/APIReference/API_SendMessageBatch.html). ACKs parciais são tratados por evento; os rejeitados recebem retry, e eventos seguintes do mesmo agregado continuam bloqueados.

O resultado ainda não é capacidade de produção: são amostras curtas locais de uma única instância, com variação relevante de throughput/latência e concorrência de API e publisher no mesmo PostgreSQL. A fila FIFO de eventos no LocalStack não foi purgada: pode conter mensagens deste ensaio e de testes anteriores, então a contagem aproximada da fila não deve ser atribuída só a uma execução.

Próxima investigação: separar o publisher da API ou aplicar limites independentes de CPU/conexões, depois executar várias rodadas controladas e uma janela sustentada para medir p95/p99, taxa de erro, lock waits e lag. Não aumentar concorrência por agregado sem preservar a ordenação FIFO e a semântica por versão.

Reprodução: consulte [README — teste de carga](../../README.md) e execute `bun --env-file=.env run test:load` com a API local saudável, `LOAD_BASE_URL` local e `LOAD_ADMIN_DATABASE_URL` apontando ao banco local de desenvolvimento. O runner exige privilégios administrativos somente para cleanup exato dos dados criados por ele.
