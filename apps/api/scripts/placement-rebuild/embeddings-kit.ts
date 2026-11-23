import { VoyageEmbeddingProvider } from "../../src/assistant/voyage-embedding-provider.js";
import type { EmbeddingProvider } from "../../src/assistant/ports.js";
import type { AppConfig } from "../../src/config.js";
import { FakeEmbeddingProvider } from "./fakes.js";

/** O provedor de vetores da ferramenta: o falso (ensaio), o da Voyage (com `VOYAGE_API_KEY`) ou nenhum. Nunca lê `.env*`: a chave vem da configuração do processo. */
export function embeddingProviderFor(config: AppConfig, fake: boolean): EmbeddingProvider | null {
  if (fake) return new FakeEmbeddingProvider();
  return config.VOYAGE_API_KEY ? new VoyageEmbeddingProvider({ apiKey: config.VOYAGE_API_KEY, timeoutMs: 30_000 }) : null;
}
