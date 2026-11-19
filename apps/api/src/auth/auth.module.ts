import { createClerkClient } from "@clerk/backend";
import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { CONFIG } from "../config.js";
import type { AppConfig } from "../config.js";
import { AuthGuard } from "./auth.guard.js";
import { ClerkDirectoryProvider } from "./clerk-directory-provider.js";
import type { ClerkAuthenticator } from "./clerk-session-verifier.js";
import { ClerkSessionVerifier } from "./clerk-session-verifier.js";
import { DIRECTORY_PROVIDER } from "./directory-provider.js";
import { SESSION_VERIFIER } from "./session-verifier.js";

const CLERK_CLIENT = Symbol("CLERK_CLIENT");

/** Estreita o `ClerkClient` (sobrecargas do SDK) para a porta usada pelo verificador. */
function toAuthenticator(client: ReturnType<typeof createClerkClient>): ClerkAuthenticator {
  return {
    async authenticateRequest(request, options) {
      const state = await client.authenticateRequest(request, options);
      return {
        isAuthenticated: state.isAuthenticated,
        toAuth: (opts) => (state.isAuthenticated ? state.toAuth(opts) : null),
      };
    },
  };
}

@Module({
  providers: [
    {
      provide: CLERK_CLIENT,
      inject: [CONFIG],
      useFactory: (config: AppConfig) =>
        createClerkClient({
          secretKey: config.CLERK_SECRET_KEY,
          publishableKey: config.CLERK_PUBLISHABLE_KEY,
          ...(config.CLERK_JWT_KEY ? { jwtKey: config.CLERK_JWT_KEY } : {}),
        }),
    },
    {
      provide: SESSION_VERIFIER,
      inject: [CLERK_CLIENT, CONFIG],
      useFactory: (client: ReturnType<typeof createClerkClient>, config: AppConfig) =>
        new ClerkSessionVerifier(toAuthenticator(client), {
          appOrigin: config.APP_ORIGIN,
          jwtKey: config.CLERK_JWT_KEY,
        }),
    },
    {
      provide: DIRECTORY_PROVIDER,
      inject: [CLERK_CLIENT],
      useFactory: (client: ReturnType<typeof createClerkClient>) => new ClerkDirectoryProvider(client),
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [DIRECTORY_PROVIDER],
})
export class AuthModule {}
