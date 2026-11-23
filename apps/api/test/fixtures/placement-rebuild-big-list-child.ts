/**
 * Processo filho do teste de saída da ferramenta: lista falsa de N tickets pelo `ticket-list --json` de verdade, impressa e
 * encerrada pelo mesmo caminho do `placement-rebuild.ts` (`log` e `exitAfterFlush`).
 */
import type { ApiClient } from "../../scripts/placement-rebuild/client.js";
import { exitAfterFlush, log } from "../../scripts/placement-rebuild/output.js";
import { ticketListCommand } from "../../scripts/placement-rebuild/ticket-commands.js";

const total = Number(process.argv[2] ?? "2000");
const rows = Array.from({ length: total }, (_, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  number: i + 1,
  key: `BIG-${i + 1}`,
  parentId: null,
  title: `Ticket número ${i + 1} com um título razoavelmente longo para encher a saída`,
  status: "todo",
  progress: null,
}));
const client = { request: () => Promise.resolve({ status: 200, body: rows }) } as unknown as ApiClient;

await ticketListCommand({ client, project: "p", log }, true);
await exitAfterFlush(0);
