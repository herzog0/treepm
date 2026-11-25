import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ADR 0058: texto livre de ticket (título, descrição) só entra por `ticketTitleSchema`/`ticketDescriptionSchema`, que recusam nome de pessoa em
// formato de menção. Este teste falha se um esquema declarar um campo `description` como `z.string(...)` solto: ou ele passa a usar o esquema
// comum, ou entra na lista abaixo com o motivo (saída da API, formato pedido ao provedor, ou texto que nunca vai à IA nem ao MCP).
const ROOT = join(import.meta.dirname, "..", "src");
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : name.endsWith(".ts") ? [join(dir, name)] : []));

/** `arquivo: linha` → motivo. */
const ALLOWED: Record<string, string> = {
  "tickets/tickets.schema.ts: description: z.string(),": "saída (detalhe do ticket)",
  "linear/linear-client.ts: description: z.string().nullable().optional(),": "leitura da resposta do Linear (entrada de rede, não de pessoa); o texto passa por mapLinearDescription, que neutraliza menção, antes de virar ticket",
  "query/query.schema.ts: description: z.string(),": "saída (leitura)",
  "mcp/mcp-tools.ts: description: z.string().describe(\"Full description, never cut.\"),": "saída da leitura do MCP",
  "assistant/conversations.schema.ts: description: z.string().max(MAX_SUGGESTED_DESCRIPTION_CHARS).default(\"\"),": "sugestão do assistente (saída); a criação reenvia pelo esquema comum",
  "assistant/conversations.schema.ts: description: z.string(),": "saída (rascunho, proposta)",
  "assistant/claude-ticket-elaborator.ts: description: z.string().describe(\"Descrição da tarefa sugerida.\"),": "formato pedido ao provedor (saída dele)",
  "assistant/claude-conversation-provider.ts: description: z.string(),": "formato pedido ao provedor (saída dele); depois passa pelo esquema comum",
  "assistant/claude-group-namer.ts: description: z.string().describe(\"Descrição do agrupador.\"),": "formato pedido ao provedor (saída dele)",
  "assistant/description-draft.schema.ts: description: z.string().max(MAX_DRAFT_DESCRIPTION).refine((text) => !mentionsPersonRaw(text), noPersonMention),": "entrada, com a conferência",
};

describe("guarda: campo de descrição fora do esquema comum", () => {
  it("todo `description: z.string(` está na lista de motivos", () => {
    const found = new Set<string>();
    for (const file of files(ROOT)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const text = line.trim();
        if (/^description\??: z\.string\(/.test(text)) found.add(`${file.slice(ROOT.length + 1)}: ${text}`);
      }
    }
    const unexplained = [...found].filter((entry) => !(entry in ALLOWED));
    expect(unexplained, "use ticketDescriptionSchema (recusa menção de pessoa) ou justifique na lista").toEqual([]);
  });
});
