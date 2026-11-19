import type { INestApplication } from "@nestjs/common";

/** Configuração HTTP compartilhada entre `main.ts` e os testes. */
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();
}
