import "reflect-metadata";
import type { INestApplication, Type } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { APP_URL, OWNER_URL, ownerPool } from "@treepm/db/testing";
import type pg from "pg";
import { AppModule } from "../src/app.module.js";
import { configureApp } from "../src/bootstrap.js";
import type { AppConfig } from "../src/config.js";
import { CONFIG } from "../src/config.js";
import type { DirectoryProvider } from "../src/auth/directory-provider.js";
import { DIRECTORY_PROVIDER } from "../src/auth/directory-provider.js";
import type { SessionVerifier, VerifiedSession } from "../src/auth/session-verifier.js";
import { SESSION_VERIFIER } from "../src/auth/session-verifier.js";

export { OWNER_URL };

export const TEST_CONFIG: AppConfig = {
  DATABASE_URL: APP_URL,
  CLERK_SECRET_KEY: "sk_test_fake",
  CLERK_PUBLISHABLE_KEY: "pk_test_fake",
  APP_ORIGIN: "http://localhost:5173",
  PORT: 3000,
};

/** Verificador falso: a sessão vem do cabeçalho `x-test-session` (JSON); ausente = sem sessão. */
export class FakeSessionVerifier implements SessionVerifier {
  verify(request: { headers: Record<string, string | string[] | undefined> }): Promise<VerifiedSession | null> {
    const raw = request.headers["x-test-session"];
    if (typeof raw !== "string") return Promise.resolve(null);
    return Promise.resolve(JSON.parse(raw) as VerifiedSession);
  }
}

export function sessionHeader(session: Partial<VerifiedSession> & { userId: string }): string {
  return JSON.stringify({
    orgId: null,
    orgRole: null,
    sessionStatus: "active",
    ...session,
  });
}

export type DirectoryCalls = { users: string[]; organizations: string[] };

/** Diretório falso determinístico, com chamadas registradas. */
export class FakeDirectory implements DirectoryProvider {
  readonly calls: DirectoryCalls = { users: [], organizations: [] };
  getUser(userId: string) {
    this.calls.users.push(userId);
    return Promise.resolve({
      displayName: `Nome de ${userId}`,
      email: `${userId}@exemplo.test`,
      avatarUrl: `https://img.test/${userId}.png`,
    });
  }
  getOrganization(orgId: string) {
    this.calls.organizations.push(orgId);
    return Promise.resolve({ name: `Organização ${orgId}`, slug: orgId.toLowerCase() });
  }
}

export async function createTestApp(
  extraControllers: Type<unknown>[] = [],
  config: AppConfig = TEST_CONFIG,
): Promise<{ app: INestApplication; directory: FakeDirectory }> {
  const directory = new FakeDirectory();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
    controllers: extraControllers,
  })
    .overrideProvider(CONFIG)
    .useValue(config)
    .overrideProvider(SESSION_VERIFIER)
    .useValue(new FakeSessionVerifier())
    .overrideProvider(DIRECTORY_PROVIDER)
    .useValue(directory)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  await app.init();
  return { app, directory };
}

export function ownerPoolWithCleanup(): pg.Pool {
  return ownerPool();
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query("truncate organizations cascade");
}
