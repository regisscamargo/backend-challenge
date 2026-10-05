export interface ProcessingObservation {
  correlationId: string;
  messageId?: string;
  walletId: string;
  providerId: string;
  transactionId?: string;
  status: string;
  replay: boolean;
  durationSeconds: number;
}

export interface ProcessingTelemetry {
  record(observation: ProcessingObservation): void;
  retry(source: "reference" | "outbox" | "sqs"): void;
  lockFailure(code: string): void;
}
