import { randomUUID } from "node:crypto";
import { Client } from "pg";

const baseUrl = process.env.LOAD_BASE_URL;
if (!baseUrl) throw new Error("LOAD_BASE_URL must target the local API configured in .env");
const adminDatabaseUrl = process.env.LOAD_ADMIN_DATABASE_URL;
if (!adminDatabaseUrl) throw new Error("LOAD_ADMIN_DATABASE_URL is required for precise cleanup");

const runId = randomUUID();
const playerId = randomUUID();
const providerId = `load-${runId}`;
const initialBalance = "10000.00";
const phases = [
  { name: "baseline", requests: 100, concurrency: 5 },
  { name: "contention", requests: 300, concurrency: 15 },
] as const;
const db = new Client({ connectionString: adminDatabaseUrl });
let walletId: string | undefined;
const externalIds: string[] = [];
const durations: number[] = [];
const errors: Array<{ status: number | string; body: string }> = [];
let sent = 0;

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1] ?? 0;
}

async function request(url: string, init?: RequestInit, measureLatency = true) {
  const start = performance.now();
  try {
    const response = await fetch(url, init);
    const body = await response.text();
    if (measureLatency) durations.push(performance.now() - start);
    if (!response.ok) errors.push({ status: response.status, body: body.slice(0, 300) });
    return { response, body };
  } catch (error) {
    if (measureLatency) durations.push(performance.now() - start);
    errors.push({ status: "network", body: String(error).slice(0, 300) });
    return undefined;
  }
}

async function runPhase(phase: (typeof phases)[number]) {
  const queue = Array.from({ length: phase.requests }, (_, index) => index);
  let cursor = 0;
  const workers = Array.from({ length: phase.concurrency }, async () => {
    while (cursor < queue.length) {
      const index = queue[cursor++]!;
      const externalTransactionId = `${phase.name}-${index}-${randomUUID()}`;
      externalIds.push(externalTransactionId);
      const result = await request(`${baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `${providerId}:${externalTransactionId}` },
        body: JSON.stringify({ providerId, externalTransactionId, playerId, walletId,
          roundId: runId, gameId: "load-test", kind: "BET", money: { amount: "0.01", currency: "BRL" } }),
      });
      sent++;
      if (result && result.response.status !== 201) continue;
    }
  });
  const phaseStarted = Date.now();
  await Promise.all(workers);
  const elapsedSeconds = (Date.now() - phaseStarted) / 1000;
  return { name: phase.name, requests: phase.requests, concurrency: phase.concurrency,
    durationSeconds: Number(elapsedSeconds.toFixed(3)), throughputRps: Number((phase.requests / elapsedSeconds).toFixed(2)) };
}

async function waitForOutboxDrain() {
  const started = Date.now();
  let initialPending: number | undefined;
  let oldestEventLagSeconds: number | undefined;
  // Wait for asynchronous publication before removing this run's outbox rows.
  while (Date.now() - started < 180_000) {
    const response = await fetch(`${baseUrl}/metrics`);
    if (!response.ok) throw new Error(`Metrics endpoint returned ${response.status}`);
    const metrics = await response.text();
    const pending = Number(metrics.match(/^wager_outbox_pending (\d+(?:\.\d+)?)$/m)?.[1]);
    const lag = Number(metrics.match(/^wager_outbox_lag_seconds (\d+(?:\.\d+)?)$/m)?.[1]);
    if (Number.isFinite(pending)) initialPending ??= pending;
    if (Number.isFinite(lag)) oldestEventLagSeconds = lag;
    if (pending === 0) return { initialPending, drained: true, drainSeconds: Number(((Date.now() - started) / 1000).toFixed(3)), oldestEventLagSeconds };
    await Bun.sleep(200);
  }
  return { initialPending, drained: false, drainSeconds: Number(((Date.now() - started) / 1000).toFixed(3)), oldestEventLagSeconds };
}

try {
  await db.connect();
  const created = await request(`${baseUrl}/wallets`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, initialBalance: { amount: initialBalance, currency: "BRL" } }),
  }, false);
  if (!created?.response.ok) throw new Error(`Wallet setup failed: ${created?.response.status ?? "network"} ${created?.body ?? ""}`);
  walletId = (JSON.parse(created.body) as { id: string }).id;

  const phaseResults = [];
  for (const phase of phases) {
    phaseResults.push(await runPhase(phase));
    if (errors.length) break;
  }

  const outbox = await waitForOutboxDrain();
  const walletResponse = await request(`${baseUrl}/wallets/${walletId}`, undefined, false);
  const wallet = walletResponse?.response.ok ? JSON.parse(walletResponse.body) as { balance: { amount: string }; version: number } : undefined;
  const expectedBalance = (1000000 - sent) / 100;
  const correctBalance = wallet?.balance.amount === expectedBalance.toFixed(2) && wallet.version === sent + 1;
  const requestDurationSeconds = phaseResults.reduce((total, phase) => total + phase.durationSeconds, 0);
  const result = {
    runId, environment: "local Docker Compose; PostgreSQL + LocalStack SQS", sent,
    successfulHttp: sent - errors.length, errorCount: errors.length,
    requestThroughputRps: Number((sent / requestDurationSeconds).toFixed(2)),
    latencyMs: { p50: Number(percentile(durations, 0.50).toFixed(2)), p95: Number(percentile(durations, 0.95).toFixed(2)), p99: Number(percentile(durations, 0.99).toFixed(2)), max: Number(Math.max(0, ...durations).toFixed(2)) },
    phases: phaseResults, outbox, correctness: { expectedBalance: expectedBalance.toFixed(2), actualBalance: wallet?.balance.amount, expectedVersion: sent + 1, actualVersion: wallet?.version, passed: correctBalance },
    sampleErrors: errors.slice(0, 5),
  };
  console.log(JSON.stringify(result, null, 2));
  if (errors.length || !correctBalance || !outbox.drained || sent !== phases.reduce((sum, phase) => sum + phase.requests, 0)) process.exitCode = 1;
} finally {
  if (walletId) {
    await db.query("BEGIN");
    try {
      await db.query("SET LOCAL session_replication_role = 'replica'");
      await db.query("DELETE FROM inbox_messages WHERE message_id = ANY($1::varchar[])", [externalIds]);
      const tx = await db.query<{ id: string }>("SELECT id FROM wager_transactions WHERE provider_id = $1", [providerId]);
      const transactionIds = tx.rows.map(row => row.id);
      await db.query("DELETE FROM outbox_messages WHERE aggregate_id = $1 OR aggregate_id = ANY($2::uuid[])", [walletId, transactionIds]);
      await db.query("DELETE FROM wallet_ledger_entries WHERE wallet_id = $1", [walletId]);
      await db.query("DELETE FROM wager_transactions WHERE provider_id = $1", [providerId]);
      await db.query("DELETE FROM wallets WHERE id = $1", [walletId]);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      console.error(`Targeted load-test cleanup failed for run ${runId}:`, error);
      process.exitCode = 1;
    }
  }
  await db.end();
}
