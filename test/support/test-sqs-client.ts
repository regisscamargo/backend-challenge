import { SQSClient } from "@aws-sdk/client-sqs";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be configured in the local .env`);
  return value;
}

export function createTestSqsClient(maxAttempts = 1): SQSClient {
  return new SQSClient({
    region: requiredEnv("AWS_REGION"),
    endpoint: requiredEnv("AWS_ENDPOINT_URL"),
    credentials: {
      accessKeyId: requiredEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("AWS_SECRET_ACCESS_KEY"),
    },
    maxAttempts,
  });
}
