import { readFileSync } from "node:fs";
import { expectOk } from "./client.js";
import { importGabarito, readGabarito } from "./commands.js";
import type { Context, Summary } from "./commands.js";
import { runDryRun } from "./conversation-dry-run.js";
import type { Decision } from "./conversation-dry-run.js";
import type { Gabarito, GabaritoTicket } from "./core.js";
import { probabilitiesOf } from "./conversation-dry-run.js";

/**
 * `case-run`: o caso de medição fixo da ADR 0052. Cria um projeto de medição a partir da árvore exportada (`export`), SEM
 * os tickets de `omit` e os descendentes deles, roda o pedido pela conversa a seco N vezes, compara o destino com o pai
 * esperado e arquiva o projeto no fim, com sucesso ou erro. As chaves do arquivo de caso são as do projeto exportado (o
 * `gabarito.json` de `--dir`); a ferramenta traduz para as do projeto de medição e imprime de volta nas do original.
 *
 * Formato do arquivo de caso (exemplo em `cases/sincronizar.example.json`):
 *   { "name": "…", "request": "texto do pedido, como a pessoa o digitaria",
 *     "expectParentKey": "chave do pai esperado", "acceptKeys": ["outras chaves que também valem"], "omit": ["chaves a tirar da árvore"],
 *     "expectRelatedKeys": ["opcional: chaves que têm de aparecer entre os relacionados"], "expectDuplicateKey": "opcional: chave do duplicado esperado" }
 */
export type CaseFile = {
  name: string;
  request: string;
  expectParentKey: string;
  acceptKeys: string[];
  omit: string[];
  /** Opcional (ADR 0052, fatia 2): passa se todas estas chaves aparecem entre os relacionados. */
  expectRelatedKeys: string[];
  /** Opcional: o duplicado apontado tem de ser este. */
  expectDuplicateKey: string | null;
  /** Opcional (ADR 0052, fatia 3): passa se todas estas chaves aparecem em `links[].dependeDe`. */
  expectLinkKeys: string[];
};

export class CaseError extends Error {
  override name = "CaseError";
}

export function parseCase(raw: string): CaseFile {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new CaseError("O arquivo de caso não é JSON válido.");
  }
  const record = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const text = (name: string): string => {
    const field = record[name];
    if (typeof field !== "string" || field.trim() === "") throw new CaseError(`O arquivo de caso precisa de "${name}" (texto).`);
    return field;
  };
  const list = (name: string): string[] => {
    const field = record[name];
    if (field === undefined) return [];
    if (!Array.isArray(field) || field.some((item) => typeof item !== "string")) throw new CaseError(`"${name}" deve ser uma lista de chaves.`);
    return field as string[];
  };
  const optionalKey = (name: string): string | null => {
    const field = record[name];
    if (field === undefined || field === null) return null;
    if (typeof field !== "string" || field.trim() === "") throw new CaseError(`"${name}" deve ser uma chave de ticket.`);
    return field;
  };
  return {
    name: typeof record["name"] === "string" ? record["name"] : "caso",
    request: text("request"),
    expectParentKey: text("expectParentKey"),
    acceptKeys: list("acceptKeys"),
    omit: list("omit"),
    expectRelatedKeys: list("expectRelatedKeys"),
    expectDuplicateKey: optionalKey("expectDuplicateKey"),
    expectLinkKeys: list("expectLinkKeys"),
  };
}

/** A árvore sem os tickets de `omit` e sem o que está dentro deles. As chaves que não existem no gabarito são erro. */
export function withoutOmitted(tickets: readonly GabaritoTicket[], omitKeys: readonly string[]): GabaritoTicket[] {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const dropped = new Set<string>();
  for (const key of omitKeys) {
    const ticket = byKey.get(key);
    if (!ticket) throw new CaseError(`"omit" cita ${key}, que não existe na árvore exportada.`);
    dropped.add(ticket.id);
  }
  const childrenOf = new Map<string, GabaritoTicket[]>();
  for (const t of tickets) if (t.parentId !== null) childrenOf.set(t.parentId, [...(childrenOf.get(t.parentId) ?? []), t]);
  const stack = [...dropped];
  while (stack.length > 0) {
    for (const child of childrenOf.get(stack.pop() as string) ?? []) {
      if (!dropped.has(child.id)) {
        dropped.add(child.id);
        stack.push(child.id);
      }
    }
  }
  return tickets.filter((t) => !dropped.has(t.id));
}

export type CaseRepeat = {
  repeat: number;
  destinationKey: string | null;
  /** O caso passou nesta repetição: destino, relacionados e duplicado esperados (os que o caso pede). */
  hit: boolean;
  destinationHit: boolean;
  relatedHit: boolean;
  duplicateHit: boolean;
  /** Todas as `expectLinkKeys` apareceram em `links[].dependeDe` (verdadeiro quando o caso não pede nenhuma). */
  linkHit: boolean;
  related: (string | null)[];
  duplicate: string | null;
  /** A elaboração (ADR 0052, fatia 3), com as chaves do projeto original; vazias quando o modelo não respondeu (`elaborationUnavailable`). */
  links: { de: "pai" | number; dependeDe: string | null; dependeDeTitle: string; motivo: string }[];
  suggested: { title: string; description: string; motivo: string }[];
  elaborationUnavailable: string | null;
  uncertain: boolean;
  stopReason: string | null;
  probabilities: ReturnType<typeof probabilitiesOf> | null;
};

const randomKey = (): string => `CS${Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join("")}`;

export async function caseRunCommand(ctx: Context, input: { caseFile: string; repeats: number }): Promise<boolean> {
  let raw: string;
  try {
    raw = readFileSync(input.caseFile, "utf8");
  } catch {
    throw new CaseError(`Não consegui ler o arquivo de caso ${input.caseFile}.`);
  }
  const spec = parseCase(raw);
  const gabarito = readGabarito(ctx.dir);
  const kept = withoutOmitted(gabarito.tickets, spec.omit);
  const byKey = new Map(kept.map((t) => [t.key, t]));
  const accepted = [spec.expectParentKey, ...spec.acceptKeys].map((key) => {
    const ticket = byKey.get(key);
    if (!ticket) throw new CaseError(`${key} (pai esperado ou aceito) não está na árvore depois de tirar o que o caso omite.`);
    return ticket;
  });

  for (const key of [...spec.expectRelatedKeys, ...spec.expectLinkKeys, ...(spec.expectDuplicateKey === null ? [] : [spec.expectDuplicateKey])]) {
    if (!byKey.has(key)) throw new CaseError(`${key} (relacionado, ligação ou duplicado esperado) não está na árvore depois de tirar o que o caso omite.`);
  }

  const project = expectOk<{ id: string; key: string }>(
    "criar projeto de medição",
    await ctx.client.request("POST", "/projects", { key: randomKey(), name: `Caso ${spec.name}`.slice(0, 80) }),
  );
  const measured: Context = { ...ctx, project: project.id };
  ctx.log(`Projeto de medição ${project.key} criado (${kept.length} tickets, ${gabarito.tickets.length - kept.length} omitidos).`);
  let ok = true;
  try {
    const trimmed: Gabarito = { ...gabarito, tickets: kept };
    const { created, order } = await importGabarito(measured, trimmed);
    const newOf = new Map(order.map((oldId, index) => [oldId, created[index] as Summary]));
    const originalKeyOfNewId = new Map([...newOf].map(([oldId, summary]) => [summary.id, kept.find((t) => t.id === oldId)?.key ?? summary.key]));
    const keyOf = (id: string | null): string | null => (id === null ? null : (originalKeyOfNewId.get(id) ?? null));
    const acceptedNewIds = new Set(accepted.map((t) => (newOf.get(t.id) as Summary).id));

    const results: CaseRepeat[] = [];
    for (let repeat = 1; repeat <= input.repeats; repeat++) {
      const run = await runDryRun(measured, spec.request);
      const destinationId = run.outcome.destination.parentId;
      const destinationHit = destinationId !== null && acceptedNewIds.has(destinationId);
      const related = (run.outcome.related ?? []).map((item) => keyOf(item.id));
      const duplicate = run.outcome.duplicate ? keyOf(run.outcome.duplicate.id) : null;
      const relatedHit = spec.expectRelatedKeys.every((key) => related.includes(key));
      const duplicateHit = spec.expectDuplicateKey === null || duplicate === spec.expectDuplicateKey;
      // A API devolve as chaves do projeto de medição; o id do relacionado liga de volta à chave do projeto original.
      const idOfKey = new Map((run.outcome.related ?? []).map((item) => [item.key, item.id]));
      const links = (run.elaboration?.links ?? []).map((link) => ({ ...link, dependeDe: keyOf(idOfKey.get(link.dependeDe) ?? null) }));
      const linkHit = spec.expectLinkKeys.every((key) => links.some((link) => link.dependeDe === key));
      const record: CaseRepeat = {
        repeat,
        destinationKey: keyOf(destinationId),
        hit: destinationHit && relatedHit && duplicateHit && linkHit,
        destinationHit,
        relatedHit,
        duplicateHit,
        linkHit,
        related,
        duplicate,
        links,
        suggested: run.elaboration?.suggested ?? [],
        elaborationUnavailable: run.elaboration === null ? "unavailable" : run.elaboration.unavailable,
        uncertain: run.outcome.uncertain as boolean,
        stopReason: run.decision?.stopReason ?? null,
        probabilities: run.decision ? probabilitiesOf(run.decision as Decision, keyOf) : null,
      };
      results.push(record);
      ctx.log(JSON.stringify(record));
    }
    const hits = results.filter((r) => r.hit).length;
    const destinations = new Map<string, number>();
    for (const r of results) destinations.set(r.destinationKey ?? "(raiz)", (destinations.get(r.destinationKey ?? "(raiz)") ?? 0) + 1);
    ctx.log(
      JSON.stringify({
        summary: true,
        destinationHits: results.filter((r) => r.destinationHit).length,
        case: spec.name,
        expect: spec.expectParentKey,
        accepted: accepted.map((t) => t.key),
        repeats: input.repeats,
        hits,
        distinctDestinations: [...destinations].map(([key, count]) => ({ key, count })),
        belongsAtFirstLevel: results.map((r) => r.probabilities?.levels[0]?.belongs ?? null),
      }),
    );
    ok = hits === input.repeats;
  } finally {
    // Arquiva também em caso de erro; um erro ao arquivar não esconde o erro de quem chamou.
    const archived = await ctx.client.request("PATCH", `/projects/${project.id}`, { archived: true });
    ctx.log(archived.status >= 200 && archived.status < 300 ? `Projeto de medição ${project.key} arquivado.` : `ATENÇÃO: não consegui arquivar o projeto de medição ${project.key} (${archived.status}).`);
  }
  return ok;
}
