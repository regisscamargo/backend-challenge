import { BeforeApplicationShutdown } from "@nestjs/common";
import { PublishOutboxUseCase } from "../../../application/outbox/publish-outbox.use-case";
import { SqsWagerTransactionConsumer } from "./sqs-wager-transaction.consumer";

/** Start explicitly from the entrypoint; embedding AppModule does not launch workers. */
export class MessagingRuntime implements BeforeApplicationShutdown {
  private stopping = false;
  private running: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    private readonly consumer: SqsWagerTransactionConsumer,
    private readonly publisher: PublishOutboxUseCase,
    private readonly onPublisherFailure: () => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.stopping = false;
    this.running = Promise.all([this.consumer.start(), this.publishContinuously()]).then(() => {});
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    this.consumer.stop();
    this.wake?.();
    await this.running;
    this.running = undefined;
  }

  private async publishContinuously(): Promise<void> {
    while (!this.stopping) {
      try {
        const result = await this.publisher.execute(new Date(), 100);
        // Keep draining immediately while due work is available. Idle polling
        // remains bounded to one second when the queue is empty or retrying.
        if (result.published > 0) continue;
      } catch {
        this.onPublisherFailure();
      }
      if (this.stopping) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        this.wake = () => { clearTimeout(timer); resolve(); };
      });
      this.wake = undefined;
    }
  }
}
