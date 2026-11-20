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
import { CONVERSATION_PROVIDER } from "../src/assistant/ports.js";
import { FakeConversationProvider } from "./assistant-fakes.js";

export { OWNER_URL };

export const TEST_CONFIG: AppConfig = {
  DATABASE_URL: APP_URL,
  CLERK_SECRET_KEY: "sk_test_fake",
  CLERK_PUBLISHABLE_KEY: "pk_test_fake",
  APP_ORIGIN: "http://localhost:5173",
  PORT: 4310,
};

/** Verificador falso: a sessão vem do cabeçalho `x-test-session` (JSON); ausente = sem sessão. */
export class FakeSessionVerifier implements SessionVerifier {
  /** Pares `userId:orgId` removidos no Clerk: o verificador deixa de devolver aquela organização. */
  readonly removed = new Set<string>();

  verify(request: { headers: Record<string, string | string[] | undefined> }): Promise<VerifiedSession | null> {
    const raw = request.headers["x-test-session"];
    if (typeof raw !== "string") return Promise.resolve(null);
    const session = JSON.parse(raw) as VerifiedSession;
    if (session.orgId && this.removed.has(`${session.userId}:${session.orgId}`)) {
      return Promise.resolve({ ...session, orgId: null, orgRole: null });
    }
    return Promise.resolve(session);
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

/** Configuração com a IA ligada (as duas chaves; nenhuma é usada, os provedores são falsos). */
export const AI_CONFIG: AppConfig = { ...TEST_CONFIG, ANTHROPIC_API_KEY: "a", TYPESAFE_API_KEY: "t" };

export type DirectoryCalls = { users: string[]; organizations: string[] };

/** Diretório falso determinístico, com chamadas registradas. */
export class FakeDirectory implements DirectoryProvider {
  readonly calls: DirectoryCalls = { users: [], organizations: [] };
  /** Gancho executado a cada consulta (por exemplo, para observar o banco). */
  onCall: (() => Promise<void>) | null = null;
  async getUser(userId: string) {
    this.calls.users.push(userId);
    await this.onCall?.();
    return Promise.resolve({
      displayName: `Nome de ${userId}`,
      email: `${userId}@exemplo.test`,
      avatarUrl: `https://img.test/${userId}.png`,
    });
  }
  async getOrganization(orgId: string) {
    this.calls.organizations.push(orgId);
    await this.onCall?.();
    return Promise.resolve({ name: `Organização ${orgId}`, slug: orgId.toLowerCase() });
  }
}

export async function createTestApp(
  extraControllers: Type<unknown>[] = [],
  config: AppConfig = TEST_CONFIG,
  options: { realAssistant?: boolean } = {},
): Promise<{
  app: INestApplication;
  directory: FakeDirectory;
  verifier: FakeSessionVerifier;
  conversation: FakeConversationProvider;
}> {
  const directory = new FakeDirectory();
  const verifier = new FakeSessionVerifier();
  const conversation = new FakeConversationProvider();
  let builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: extraControllers,
  });
  if (!options.realAssistant) builder = builder.overrideProvider(CONVERSATION_PROVIDER).useValue(conversation);
  const moduleRef = await builder
    .overrideProvider(CONFIG)
    .useValue(config)
    .overrideProvider(SESSION_VERIFIER)
    .useValue(verifier)
    .overrideProvider(DIRECTORY_PROVIDER)
    .useValue(directory)
    .compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, config);
  await app.init();
  return { app, directory, verifier, conversation };
}

export function ownerPoolWithCleanup(): pg.Pool {
  return ownerPool();
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query("truncate organizations cascade");
}
