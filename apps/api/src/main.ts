import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module.js";
import { configureApp } from "./bootstrap.js";
import { CONFIG } from "./config.js";
import type { AppConfig } from "./config.js";

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get<AppConfig>(CONFIG);
  configureApp(app, config);
  await app.listen(config.PORT);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
