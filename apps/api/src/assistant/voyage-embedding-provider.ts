import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, EmbeddingError } from "./ports.js";
import type { EmbeddingFailure, EmbeddingKind, EmbeddingProvider } from "./ports.js";

/** Voyage AI, `POST /v1/embeddings` (docs.voyageai.com/reference/embeddings-api, lida em 2026-11-23). */
const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";
/** Textos por requisição (a Voyage aceita até 1 000; lotes menores mantêm cada chamada dentro do prazo). */
export const VOYAGE_BATCH_SIZE = 128;
/** Prazo de cada chamada HTTP, em milissegundos. */
export const VOYAGE_DEFAULT_TIMEOUT_MS = 4000;

export type VoyageOptions = {
  apiKey: string;
  /** Prazo por chamada HTTP (ms); padrão 4 s. */
  timeoutMs?: number;
  /** Só os testes trocam. */
  fetch?: typeof fetch;
};

const failureOfStatus = (status: number): EmbeddingFailure =>
  status === 401 || status === 403 ? "unauthorized" : status === 429 ? "rate_limited" : status >= 500 ? "server_error" : "bad_request";

/**
 * Adaptador da Voyage AI para a porta `EmbeddingProvider` (ADR 0053): HTTP direto, `voyage-4-lite`, 512 dimensões. Só chega aqui
 * o texto de ticket montado por `ticketEmbeddingText`. Todo erro vira `EmbeddingError` com um código curto: o texto enviado, o
 * corpo da resposta e a chave nunca entram na exceção nem em log algum.
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly model = EMBEDDING_MODEL;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly options: VoyageOptions) {
    this.timeoutMs = options.timeoutMs ?? VOYAGE_DEFAULT_TIMEOUT_MS;
    this.doFetch = options.fetch ?? fetch;
  }

  async embed(texts: readonly string[], kind: EmbeddingKind, options?: { signal?: AbortSignal }): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += VOYAGE_BATCH_SIZE) {
      vectors.push(...(await this.batch(texts.slice(start, start + VOYAGE_BATCH_SIZE), kind, options?.signal)));
    }
    return vectors;
  }

  private async batch(texts: readonly string[], kind: EmbeddingKind, outer: AbortSignal | undefined): Promise<number[][]> {
    const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(this.timeoutMs)]) : AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.doFetch(VOYAGE_EMBEDDINGS_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.options.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: texts, model: EMBEDDING_MODEL, input_type: kind, output_dimension: EMBEDDING_DIMENSIONS }),
        signal,
        // Um 307/308 reenviaria o corpo, com texto de tickets, a outro destino: o redirecionamento é recusado (vira `network`).
        redirect: "error",
      });
    } catch {
      // Nada da exceção original é guardado: ela pode citar o endereço, a chave ou o texto.
      throw new EmbeddingError(signal.aborted ? "timeout" : "network");
    }
    if (!response.ok) {
      // O corpo de erro não é lido: nada dele vai adiante.
      await response.body?.cancel().catch(() => undefined);
      throw new EmbeddingError(failureOfStatus(response.status));
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new EmbeddingError(signal.aborted ? "timeout" : "malformed");
    }
    return parseVectors(body, texts.length);
  }
}

/** Confere que voltaram `expected` vetores de 512 números finitos, um por índice, e devolve na ordem dos textos. */
function parseVectors(body: unknown, expected: number): number[][] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data) || data.length !== expected) throw new EmbeddingError("malformed");
  const ordered: (number[] | undefined)[] = new Array<number[] | undefined>(expected).fill(undefined);
  for (const item of data as { embedding?: unknown; index?: unknown }[]) {
    const { embedding, index } = item ?? {};
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= expected || ordered[index] !== undefined) throw new EmbeddingError("malformed");
    if (!Array.isArray(embedding) || embedding.length !== EMBEDDING_DIMENSIONS || !embedding.every((value) => typeof value === "number" && Number.isFinite(value))) throw new EmbeddingError("malformed");
    ordered[index] = embedding as number[];
  }
  return ordered as number[][];
}
