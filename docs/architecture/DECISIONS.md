# Decision Log

Registro resumido das decisões arquiteturais. Decisões maiores poderão ser separadas em ADRs.

## DEC-001 — PostgreSQL como autoridade financeira

- Status: Accepted
- Data: 2026-10-03

O PostgreSQL será a fonte de verdade para wallet, transações, ledger, Inbox e Outbox. A escolha fornece transações ACID, `NUMERIC`, constraints, locks de linha e `SKIP LOCKED`.

O ledger é append-only também no schema. Um trigger rejeita `UPDATE` e `DELETE`
independentemente do caminho de aplicação; correções financeiras devem ser
representadas por novos lançamentos compensatórios. O usuário de runtime em
produção não deve ser superusuário nem proprietário das tabelas.

MongoDB primary/secondary não será usado como substituto neste desafio: replicação não resolve, por si só, as invariantes financeiras e a necessidade de locks e constraints relacionais.

## DEC-002 — Money com decimal exato

- Status: Accepted
- Data: 2026-10-03

Valores serão recebidos e serializados como strings decimais, calculados com `decimal.js` e persistidos em `NUMERIC(15,2)`. `number`, `float` e `double` não serão usados para dinheiro.

## DEC-003 — Lock pessimista por wallet

- Status: Accepted
- Data: 2026-10-03

O processamento bloqueará somente a wallet envolvida com `SELECT FOR UPDATE`. Isso serializa operações da mesma wallet e mantém wallets diferentes em paralelo.

## DEC-004 — Idempotência separada do Inbox

- Status: Accepted
- Data: 2026-10-03

Idempotência financeira será garantida por provider e idempotency key. Deduplicação de transporte será garantida por `(consumer_name, message_id)` no Inbox. As duas garantias não serão confundidas.

## DEC-005 — Transactional Outbox

- Status: Accepted
- Data: 2026-10-03

Eventos serão persistidos na mesma transação da alteração financeira e publicados posteriormente por worker. O sistema assume entrega at-least-once e torna consumidores idempotentes.
