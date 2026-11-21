/** Provedores do comando `pairs` (ferramenta de medição, nunca o produto): os de verdade, ou os falsos do `--fake-providers`. */
import Anthropic from "@anthropic-ai/sdk";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { ClaudeBranchSummarizer } from "../../src/assistant/claude-branch-summarizer.js";
import { sdkStreamer } from "../../src/assistant/claude-call.js";
import type { ClaudeStreamer } from "../../src/assistant/claude-call.js";
import { sdkSystemOne } from "../../src/assistant/jev-branch-judge.js";
import type { SystemOneCall } from "../../src/assistant/jev-branch-judge.js";
import { assistantEnabled } from "../../src/config.js";
import type { AppConfig } from "../../src/config.js";
import { FakeSummarizer } from "./fakes.js";
import type { PairsKit } from "./pairs.js";

/** Mesmo resumidor do produto (Claude Opus 5.5, esforço low); só embrulha a chamada para ler o consumo. */
export function realPairsKit(config: AppConfig): PairsKit {
  if (!assistantEnabled(config)) {
    throw new Error("A IA está desligada (faltam ANTHROPIC_API_KEY e/ou TYPESAFE_API_KEY). Este comando precisa dela; use --fake-providers só para ensaio.");
  }
  const base = sdkStreamer(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY as string, maxRetries: 0 }));
  let usage: { inputTokens: number; outputTokens: number } | null = null;
  const counting: ClaudeStreamer = async (params, options) => {
    const final = await base(params, options);
    const u = final.usage;
    if (u) {
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        outputTokens: (usage?.outputTokens ?? 0) + (u.output_tokens ?? 0),
      };
    }
    return final;
  };
  return {
    systemOne: sdkSystemOne(new TypeSafeClient({ apiKey: config.TYPESAFE_API_KEY as string, logLevel: "off" })),
    summarizer: new ClaudeBranchSummarizer(counting),
    takeClaudeUsage: () => {
      const taken = usage;
      usage = null;
      return taken;
    },
  };
}

const words = (text: string): Set<string> => new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 4));

/** Jev falso do ensaio: 0,9 quando o candidato divide uma palavra com o rascunho, senão 0,1; responde `scope` ou `w1` e `w2`. */
export const fakePairsSystemOne: SystemOneCall = (request) => {
  const state = request.state as { draft: { title: string; description?: string }; scope?: Record<string, string>; candidate?: Record<string, string> };
  const candidate = state.scope ?? state.candidate ?? {};
  const draftWords = words(`${state.draft.title} ${state.draft.description ?? ""}`);
  const shared = [...words(Object.values(candidate).join(" "))].some((word) => draftWords.has(word));
  const answers = Object.fromEntries(Object.keys(request.questions as object).map((key) => [key, { noul: shared ? 0.9 : 0.1 }]));
  return Promise.resolve({ model: "fake-jev", answers, usage: { input_tokens: 1, output_tokens: 1 } });
};

export function fakePairsKit(): PairsKit {
  return { systemOne: fakePairsSystemOne, summarizer: new FakeSummarizer(), takeClaudeUsage: () => ({ inputTokens: 1, outputTokens: 1 }) };
}
