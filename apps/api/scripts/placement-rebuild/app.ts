import "reflect-metadata";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { Test } from "@nestjs/testing";
import { AppModule } from "../../src/app.module.js";
import { BRANCH_JUDGE, BRANCH_SUMMARIZER, CONVERSATION_PROVIDER } from "../../src/assistant/ports.js";
import type { BranchJudge, BranchJudgment } from "../../src/assistant/ports.js";
import { JevBranchJudge, sdkSystemOne } from "../../src/assistant/jev-branch-judge.js";
import { configureApp } from "../../src/bootstrap.js";
import { CONFIG, assistantEnabled, loadConfig } from "../../src/config.js";
import type { AppConfig } from "../../src/config.js";
import { DIRECTORY_PROVIDER } from "../../src/auth/directory-provider.js";
import { SESSION_VERIFIER } from "../../src/auth/session-verifier.js";
import type { SessionVerifier, VerifiedSession } from "../../src/auth/session-verifier.js";
import { FakeConversation, FakeDirectoryProvider, FakeJudge, FakeSummarizer } from "./fakes.js";
import type { JudgmentRecord } from "./core.js";

export const TOKEN_HEADER = "x-rebuild-token";

/** Guarda os julgamentos da procura em andamento (a ferramenta faz uma procura por vez). */
export class JudgmentRecorder {
  private current: JudgmentRecord[] = [];
  reset(): void {
    this.current = [];
  }
  take(): JudgmentRecord[] {
    const taken = this.current;
    this.current = [];
    return taken;
  }
  add(record: JudgmentRecord): void {
    this.current.push(record);
  }
}

class RecordingJudge implements BranchJudge {
  constructor(
    private readonly inner: BranchJudge,
    private readonly recorder: JudgmentRecorder,
  ) {}

  async judge(input: Parameters<BranchJudge["judge"]>[0], options?: { signal?: AbortSignal }): Promise<BranchJudgment> {
    const result = await this.inner.judge(input, options);
    const choice: Record<string, number> = {};
    for (const candidate of input.candidates) {
      const key = candidate.title in choice ? `${candidate.title} [${candidate.id}]` : candidate.title;
      choice[key] = result.choice[candidate.id] ?? 0;
    }
    this.recorder.add({
      current: input.current?.title ?? null,
      candidateCount: input.candidates.length,
      belongs: result.belongs,
      choice,
    });
    return result;
  }
}

export type BootOptions = {
  org: string;
  user: string;
  role: string;
  fakeProviders: boolean;
  fake503First: number;
  /** O comando precisa da IA de verdade (todos os que chamam conversa ou procura). */
  needsAi: boolean;
};

export type Booted = {
  baseUrl: string;
  token: string;
  recorder: JudgmentRecorder;
  close(): Promise<void>;
};

export async function bootApp(options: BootOptions): Promise<Booted> {
  const baseConfig = loadConfig(process.env);
  if (!options.fakeProviders && options.needsAi && !assistantEnabled(baseConfig)) {
    throw new Error("A IA está desligada (faltam ANTHROPIC_API_KEY e/ou TYPESAFE_API_KEY). Este comando precisa dela; use --fake-providers só para ensaio.");
  }
  const token = randomBytes(24).toString("hex");
  const session: VerifiedSession = { userId: options.user, orgId: options.org, orgRole: options.role, sessionStatus: "active" };
  const verifier: SessionVerifier = {
    verify: (request) => Promise.resolve(request.headers[TOKEN_HEADER] === token ? session : null),
  };
  const recorder = new JudgmentRecorder();

  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(SESSION_VERIFIER)
    .useValue(verifier);

  if (options.fakeProviders) {
    const config: AppConfig = {
      ...baseConfig,
      ANTHROPIC_API_KEY: baseConfig.ANTHROPIC_API_KEY ?? "fake",
      TYPESAFE_API_KEY: baseConfig.TYPESAFE_API_KEY ?? "fake",
    };
    builder = builder
      .overrideProvider(CONFIG)
      .useValue(config)
      .overrideProvider(DIRECTORY_PROVIDER)
      .useValue(new FakeDirectoryProvider())
      .overrideProvider(CONVERSATION_PROVIDER)
      .useValue(new FakeConversation(options.fake503First))
      .overrideProvider(BRANCH_SUMMARIZER)
      .useValue(new FakeSummarizer())
      .overrideProvider(BRANCH_JUDGE)
      .useValue(new RecordingJudge(new FakeJudge(), recorder));
  } else {
    builder = builder.overrideProvider(BRANCH_JUDGE).useFactory({
      inject: [CONFIG],
      // Mesma construção do módulo real, com o invólucro que registra cada julgamento.
      factory: (config: AppConfig) =>
        assistantEnabled(config) && config.TYPESAFE_API_KEY
          ? new RecordingJudge(new JevBranchJudge(sdkSystemOne(new TypeSafeClient({ apiKey: config.TYPESAFE_API_KEY, logLevel: "off" }))), recorder)
          : null,
    });
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, baseConfig);
  await app.init();
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${address.port}/api`, token, recorder, close: () => app.close() };
}
