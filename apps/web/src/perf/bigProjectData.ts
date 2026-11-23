/**
 * Dados da medição com projeto grande (TREEPM-191): as respostas reais da API gravadas por
 * `pnpm --filter @treepm/api measure:big-project` em `.measure/big-project/<N>/`, fora do Git.
 */
import { existsSync, readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { fileURLToPath } from "node:url";
import { createApiClient } from "../api/client.js";
import type { Person, Project, TicketSummary } from "../api/client.js";

export const MEASURE_DIR = process.env["MEASURE_DIR"] ?? fileURLToPath(new URL("../../../../.measure/big-project/", import.meta.url));
export const SIZES = (process.env["MEASURE_SIZES"] ?? "1000,5000,20000").split(",").map(Number);

export interface BigProjectData {
  readonly n: number;
  readonly projects: Project[];
  readonly people: Person[];
  readonly tickets: TicketSummary[];
  /** O corpo cru da lista, como a API o entregou. */
  readonly ticketsBody: string;
}

export const hasData = (n: number): boolean => existsSync(`${MEASURE_DIR}${n}/tickets.json`);

/** Lê as três respostas pelo cliente de verdade (`createApiClient`), com um `fetch` que devolve o arquivo: o que passa pela validação é o que a tela recebe. */
export async function loadData(n: number): Promise<BigProjectData> {
  const read = (name: string) => readFileSync(`${MEASURE_DIR}${n}/${name}.json`, "utf8");
  const bodies: Record<string, string> = { projects: read("projects"), people: read("people"), tickets: read("tickets") };
  const client = createApiClient({
    getToken: async () => "teste",
    fetch: (async (path: string) => {
      const body = path.endsWith("/tickets") ? bodies["tickets"] : path.endsWith("/people") ? bodies["people"] : bodies["projects"];
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch,
  });
  const [projects, people] = await Promise.all([client.listProjects(), client.listPeople()]);
  if (!projects.ok || !people.ok) throw new Error("respostas gravadas não passam na validação do cliente");
  const tickets = await client.listTickets(projects.data[0]!.id);
  if (!tickets.ok) throw new Error("lista de tickets gravada não passa na validação do cliente");
  return { n, projects: projects.data, people: people.data, tickets: tickets.data, ticketsBody: bodies["tickets"] as string };
}

export const stats = (xs: number[]) => {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs = sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return { medianMs: Math.round(medianMs * 100) / 100, worstMs: Math.round((sorted[sorted.length - 1] as number) * 100) / 100, minMs: Math.round((sorted[0] as number) * 100) / 100 };
};

export const loadNow = (): string => loadavg().map((x) => x.toFixed(2)).join(" / ");
export const machine = () => ({ cpu: `${cpus()[0]?.model ?? "?"} × ${cpus().length}`, node: process.version });
