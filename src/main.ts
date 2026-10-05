import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";
import { JsonLogger } from "./infrastructure/observability/json-logger";
import { MessagingRuntime } from "./infrastructure/messaging/sqs/messaging-runtime";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: new JsonLogger() });
  app.enableShutdownHooks(["SIGTERM", "SIGINT"]);
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }));
  await app.listen(Number(process.env.PORT ?? 3000));
  if (process.env.WORKERS_ENABLED !== "false") app.get(MessagingRuntime).start();
}

void bootstrap();
