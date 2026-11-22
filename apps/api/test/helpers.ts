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
import { AFFINITY_JUDGE, BRANCH_JUDGE, BRANCH_SUMMARIZER, CONVERSATION_PROVIDER, DESCRIPTION_WRITER, GROUP_NAMER, PLACEMENT_TIMEOUTS, PROJECT_ANSWERER } from "../src/assistant/ports.js";
import type { PlacementTimeouts } from "../src/assistant/ports.js";
import { REPOSITORY_PROVIDER } from "../src/github/ports.js";
import { APP_ID, FakeRepositoryProvider } from "./github-fakes.js";
import { FakeAffinityJudge, FakeBranchJudge, FakeBranchSummarizer, FakeConversationProvider, FakeDescriptionWriter, FakeGroupNamer, FakeProjectAnswerer } from "./assistant-fakes.js";

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

/** Configuração com o GitHub ligado (as cinco variáveis; valores-sentinela, nenhum é usado: o provedor é falso). */
export const GITHUB_SECRETS = {
  clientSecret: "SENTINELA-client-secret-9f3a",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nSENTINELA-chave-privada-77c1\n-----END RSA PRIVATE KEY-----\n",
} as const;
export const GITHUB_CONFIG: AppConfig = {
  ...TEST_CONFIG,
  GITHUB_APP_ID: String(APP_ID),
  GITHUB_APP_SLUG: "treepm-dev",
  GITHUB_APP_CLIENT_ID: "Iv1.sentinela",
  GITHUB_APP_CLIENT_SECRET: GITHUB_SECRETS.clientSecret,
  GITHUB_APP_PRIVATE_KEY: GITHUB_SECRETS.privateKey,
};

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
  options: { realAssistant?: boolean; realGithub?: boolean; timeouts?: PlacementTimeouts } = {},
): Promise<{
  app: INestApplication;
  directory: FakeDirectory;
  verifier: FakeSessionVerifier;
  conversation: FakeConversationProvider;
  judge: FakeBranchJudge;
  summarizer: FakeBranchSummarizer;
  affinity: FakeAffinityJudge;
  namer: FakeGroupNamer;
  writer: FakeDescriptionWriter;
  answerer: FakeProjectAnswerer;
  github: FakeRepositoryProvider;
}> {
  const directory = new FakeDirectory();
  const verifier = new FakeSessionVerifier();
  const conversation = new FakeConversationProvider();
  const judge = new FakeBranchJudge();
  const summarizer = new FakeBranchSummarizer();
  const affinity = new FakeAffinityJudge();
  const namer = new FakeGroupNamer();
  const writer = new FakeDescriptionWriter();
  const answerer = new FakeProjectAnswerer();
  const github = new FakeRepositoryProvider();
  let builder = Test.createTestingModule({
    imports: [AppModule],
    controllers: extraControllers,
  });
  if (!options.realAssistant) {
    builder = builder
      .overrideProvider(CONVERSATION_PROVIDER)
      .useValue(conversation)
      .overrideProvider(BRANCH_JUDGE)
      .useValue(judge)
      .overrideProvider(BRANCH_SUMMARIZER)
      .useValue(summarizer)
      .overrideProvider(AFFINITY_JUDGE)
      .useValue(affinity)
      .overrideProvider(GROUP_NAMER)
      .useValue(namer)
      .overrideProvider(DESCRIPTION_WRITER)
      .useValue(writer)
      .overrideProvider(PROJECT_ANSWERER)
      .useValue(answerer);
  }
  if (!options.realGithub) builder = builder.overrideProvider(REPOSITORY_PROVIDER).useValue(github);
  if (options.timeouts) builder = builder.overrideProvider(PLACEMENT_TIMEOUTS).useValue(options.timeouts);
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
  return { app, directory, verifier, conversation, judge, summarizer, affinity, namer, writer, answerer, github };
}

export function ownerPoolWithCleanup(): pg.Pool {
  return ownerPool();
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query("truncate organizations cascade");
}
