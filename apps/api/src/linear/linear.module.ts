import { Module } from "@nestjs/common";
import { AccessModule } from "../access/access.module.js";
import { ActivityService } from "../activity/activity.service.js";
import { CredentialCipher } from "../common/credential-cipher.js";
import { CONFIG } from "../config.js";
import type { AppConfig } from "../config.js";
import { HttpLinearClient } from "./linear-client.js";
import { LinearEnabledGuard } from "./linear-enabled.guard.js";
import { LinearController, ProjectLinearController } from "./linear.controller.js";
import { LinearService } from "./linear.service.js";
import { CREDENTIAL_CIPHER, LINEAR_CLIENT, LINEAR_FETCH } from "./ports.js";

/** Conexão com o Linear (ADR 0060, fatia 1): chave cifrada por pessoa e vínculo permanente do projeto com um time. */
@Module({
  imports: [AccessModule],
  controllers: [LinearController, ProjectLinearController],
  providers: [
    ActivityService,
    LinearService,
    LinearEnabledGuard,
    // O `fetch` do cliente é um provedor só para os testes o trocarem (nunca chamam o Linear de verdade).
    { provide: LINEAR_FETCH, useValue: (input: string | URL | Request, init?: RequestInit) => fetch(input, init) },
    { provide: LINEAR_CLIENT, inject: [LINEAR_FETCH], useFactory: (doFetch: typeof fetch) => new HttpLinearClient({ fetch: doFetch }) },
    // Sem `CREDENTIALS_ENCRYPTION_KEY` não há cifra: a API sobe e as rotas do Linear respondem 503.
    {
      provide: CREDENTIAL_CIPHER,
      inject: [CONFIG],
      useFactory: (config: AppConfig) => (config.CREDENTIALS_ENCRYPTION_KEY ? new CredentialCipher(Buffer.from(config.CREDENTIALS_ENCRYPTION_KEY, "base64")) : null),
    },
  ],
  exports: [LinearService],
})
export class LinearModule {}
