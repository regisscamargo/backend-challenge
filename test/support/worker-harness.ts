export interface WorkerEvent {
  type: string; pid: number; error?: string; eventId?: string;
  results?: { transactionId: string; status: string; idempotentReplay: boolean; balance?: { amount: string } }[];
  result?: { claimed: number; published: number; scheduledForRetry: number };
  attempted?: string[];
}

/** IPC barriers coordinate only test processes; financial coordination remains in PostgreSQL. */
export class Worker {
  readonly events = new Map<string, WorkerEvent>();
  readonly child: Bun.Subprocess;

  constructor(job: object, entrypoint = new URL("./concurrency-worker.ts", import.meta.url)) {
    this.child = Bun.spawn([process.execPath, entrypoint.pathname], {
      stdout: "ignore", stderr: "inherit",
      ipc: (message: WorkerEvent) => { this.events.set(message.type, message); },
    });
    this.child.send(job);
  }

  send(type: string): void { this.child.send({ type }); }

  async wait(type: string): Promise<WorkerEvent> {
    const deadline = Date.now() + 15_000;
    while (!this.events.has(type)) {
      if (this.events.has("failed")) throw new Error(this.events.get("failed")!.error);
      if (this.child.exitCode !== null) throw new Error(`Worker exited before ${type}`);
      if (Date.now() >= deadline) throw new Error(`Worker timed out before ${type}; received: ${[...this.events.keys()].join(", ")}`);
      await Bun.sleep(10);
    }
    return this.events.get(type)!;
  }

  async close(): Promise<void> {
    if (this.child.exitCode === null) this.child.kill("SIGKILL");
    await this.child.exited;
  }
}
