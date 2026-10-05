# Observabilidade

Com a API e containers ativos, consultar `GET /metrics` ou executar
`curl http://localhost:3000/metrics`. O formato é Prometheus text exposition.

| Métrica | Interpretação |
|---|---|
| wager_transactions_total | Tentativas concluídas por status, excluindo replays; ERROR indica falha da tentativa e não estado persistido |
| wager_duplicates_total | Resultados devolvidos por replay idempotente |
| wager_processing_duration_seconds | Latência de aplicação incluindo espera por lock e replay |
| wager_retries_total | Tentativas de referência ou retries agendados pelo publisher instrumentado |
| wager_lock_conflicts_total | Exceções SQL 40P01, 55P03 e 40001; não mede esperas normais por lock |
| wallet_reconciliation_divergences_total | Consultas que detectaram divergência |
| wager_outbox_pending | Eventos ainda não publicados |
| wager_outbox_lag_seconds | Idade do evento não publicado mais antigo |
| wager_dlq_messages | Quantidade aproximada de mensagens visíveis e em voo na DLQ |
| wager_metrics_dependency_up | Coleta bem-sucedida de PostgreSQL/SQS |

Contadores e histogramas são por processo e zeram no reinício. Prometheus
deve identificar instâncias e usar rate/increase. Gauges de banco e fila
refletem estado global; ao comparar múltiplas instâncias, usar max em vez
de somar. Se dependency_up for zero, o gauge daquela dependência pode estar
desatualizado. Não há labels com walletId/providerId/transactionId.

Logs financeiros contêm somente os IDs de correlação e resultado do
processamento. Valores, payloadHash, tokens, SQL e corpos de requisição não
são registrados. O logger de framework em produção registra evento/severidade
genéricos para não vazar mensagens arbitrárias de drivers.

O entrypoint inicia consumer e publisher continuamente (ver [MESSAGING_RUNTIME.md](MESSAGING_RUNTIME.md)). A
coleta da DLQ é real, mas não substitui os testes de retry/redelivery/crash.
As demais métricas são incrementadas quando a aplicação instrumentada executa.
