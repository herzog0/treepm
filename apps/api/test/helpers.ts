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
import { AFFINITY_JUDGE, BRANCH_JUDGE, BRANCH_SUMMARIZER, CHAT_PROVIDER, CONVERSATION_PROVIDER, DESCRIPTION_WRITER, EMBEDDING_PROVIDER, GROUP_NAMER, PLACEMENT_TIMEOUTS, RELATED_JUDGE, TICKET_ELABORATOR } from "../src/assistant/ports.js";
import type { PlacementTimeouts } from "../src/assistant/ports.js";
import { ACCESS_TOKEN_CLOCK } from "../src/access-tokens/clock.js";
import type { AccessTokenClock } from "../src/access-tokens/clock.js";
import { REPOSITORY_PROVIDER } from "../src/github/ports.js";
import { LINEAR_FETCH } from "../src/linear/ports.js";
import { LinearFetchSwitch } from "./linear-fake-fetch.js";
import { APP_ID, FakeRepositoryProvider } from "./github-fakes.js";
import { FakeEmbeddingProvider } from "../scripts/placement-rebuild/fakes.js";
import { FakeAffinityJudge, FakeBranchJudge, FakeBranchSummarizer, FakeChatProvider, FakeConversationProvider, FakeDescriptionWriter, FakeGroupNamer, FakeRelatedJudge, FakeTicketElaborator } from "./assistant-fakes.js";

export { OWNER_URL };

export const TEST_CONFIG: AppConfig = {
  DATABASE_URL: APP_URL,
  CLERK_SECRET_KEY: "sk_test_fake",
  CLERK_PUBLISHABLE_KEY: "pk_test_fake",
  APP_ORIGIN: "http://localhost:5173",
  PORT: 4310,
  SEMANTIC_TRIAGE: "off",
  SEMANTIC_QUERY_KIND: "query",
  PLACEMENT_DOUBT_LOW: 0.2,
  PLACEMENT_DOUBT_HIGH: 0.8,
  PLACEMENT_DOUBT_CHOICE: 0.5,
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

/** Configuração com o Linear ligado (chave de cifra de teste; o `fetch` do Linear é sempre o falso). */
export const LINEAR_KEY_BASE64 = Buffer.alloc(32, 42).toString("base64");
export const LINEAR_CONFIG: AppConfig = { ...TEST_CONFIG, CREDENTIALS_ENCRYPTION_KEY: LINEAR_KEY_BASE64 };

export type DirectoryCalls = { users: string[]; organizations: string[]; memberships: { orgId: string; userId: string }[] };

/** Diretório falso determinístico, com chamadas registradas. */
export class FakeDirectory implements DirectoryProvider {
  readonly calls: DirectoryCalls = { users: [], organizations: [], memberships: [] };
  /**
   * Participação no Clerk por `orgId:userId` (ADR 0038): o papel (`org:admin`) ou `null` para quem saiu da organização.
   * Sem entrada, vale o papel da semeadura: `u_admin` é administrador e os demais são membros.
   */
  readonly memberships = new Map<string, string | null>();
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
  async getMembership(orgId: string, userId: string) {
    this.calls.memberships.push({ orgId, userId });
    await this.onCall?.();
    const key = `${orgId}:${userId}`;
    if (this.memberships.has(key)) return this.memberships.get(key) ?? null;
    return userId === "u_admin" ? "org:admin" : "org:member";
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
  options: { realAssistant?: boolean; realGithub?: boolean; timeouts?: PlacementTimeouts; clock?: AccessTokenClock } = {},
): Promise<{
  app: INestApplication;
  directory: FakeDirectory;
  verifier: FakeSessionVerifier;
  conversation: FakeConversationProvider;
  judge: FakeBranchJudge;
  summarizer: FakeBranchSummarizer;
  affinity: FakeAffinityJudge;
  related: FakeRelatedJudge;
  namer: FakeGroupNamer;
  writer: FakeDescriptionWriter;
  chat: FakeChatProvider;
  elaborator: FakeTicketElaborator;
  embedder: FakeEmbeddingProvider;
  github: FakeRepositoryProvider;
  linear: LinearFetchSwitch;
}> {
  const directory = new FakeDirectory();
  const verifier = new FakeSessionVerifier();
  const conversation = new FakeConversationProvider();
  const judge = new FakeBranchJudge();
  const summarizer = new FakeBranchSummarizer();
  const affinity = new FakeAffinityJudge();
  const related = new FakeRelatedJudge();
  const namer = new FakeGroupNamer();
  const writer = new FakeDescriptionWriter();
  const chat = new FakeChatProvider();
  const elaborator = new FakeTicketElaborator();
  const embedder = new FakeEmbeddingProvider();
  const github = new FakeRepositoryProvider();
  const linear = new LinearFetchSwitch();
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
      .overrideProvider(RELATED_JUDGE)
      .useValue(related)
      .overrideProvider(GROUP_NAMER)
      .useValue(namer)
      .overrideProvider(DESCRIPTION_WRITER)
      .useValue(writer)
      .overrideProvider(CHAT_PROVIDER)
      .useValue(chat)
      .overrideProvider(TICKET_ELABORATOR)
      .useValue(elaborator)
      // Com `VOYAGE_API_KEY` na configuração do teste há provedor de vetores (o falso); sem ela, `null`, como no módulo real.
      .overrideProvider(EMBEDDING_PROVIDER)
      .useFactory({ inject: [CONFIG], factory: (c: AppConfig) => (c.VOYAGE_API_KEY ? embedder : null) });
  }
  builder = builder.overrideProvider(LINEAR_FETCH).useValue(linear.impl);
  if (!options.realGithub) builder = builder.overrideProvider(REPOSITORY_PROVIDER).useValue(github);
  if (options.clock) builder = builder.overrideProvider(ACCESS_TOKEN_CLOCK).useValue(options.clock);
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
  return { app, directory, verifier, conversation, judge, summarizer, affinity, related, namer, writer, chat, elaborator, embedder, github, linear };
}

/**
 * Transações da API (papel `treepm_app`) abertas e paradas NO BANCO DESTA CONEXÃO. `pg_stat_activity` é do servidor
 * inteiro: sem o filtro por banco, outra suíte rodando em outro banco do mesmo contêiner faz o teste falhar sem motivo.
 */
export async function openApiTransactions(pool: pg.Pool): Promise<number> {
  const r = await pool.query<{ n: number }>(
    "select count(*)::int as n from pg_stat_activity where usename = 'treepm_app' and datname = current_database() and state like 'idle in transaction%'",
  );
  return r.rows[0]?.n ?? -1;
}

export function ownerPoolWithCleanup(): pg.Pool {
  return ownerPool();
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query("truncate organizations cascade");
}
