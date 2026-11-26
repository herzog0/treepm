import { describe, expect, it } from "vitest";
import { LINEAR_HISTORY_NAME_CASES } from "./linear-history-name-cases.js";
import { linearHistoryActor, linearHistoryAuthor, linearHistoryChanges, linearHistoryName, linearHistoryNameRefused, LINEAR_HISTORY_NAME_MAX, LINEAR_HISTORY_TITLE_MAX } from "./linear-history.js";
import type { LinearHistoryEntryInput, LinearHistoryResolver } from "./linear-history.js";
import { mentionsPersonRaw, scanTicketKeys } from "./mentions.js";

// Histórico das issues do Linear (ADR 0061, fatia 4; TREEPM-482): a normalização pura de uma `IssueHistory` em `changes`.

const empty: LinearHistoryEntryInput = {
  id: "h1",
  createdAt: "2025-01-02T03:04:05.000Z",
  actor: null,
  botActor: null,
  fromStateId: null,
  toStateId: null,
  fromState: null,
  toState: null,
  fromAssigneeId: null,
  toAssigneeId: null,
  fromAssignee: null,
  toAssignee: null,
  fromPriority: null,
  toPriority: null,
  fromTitle: null,
  toTitle: null,
  fromParentId: null,
  toParentId: null,
  fromProjectId: null,
  toProjectId: null,
  updatedDescription: null,
};
const entry = (patch: Partial<LinearHistoryEntryInput>): LinearHistoryEntryInput => ({ ...empty, ...patch });

const resolver: LinearHistoryResolver = {
  person: (user) => (user.id === "u-ana" ? "person-ana" : null),
  ticket: (_field, linearId) => ({ "i-pai": "ticket-pai", "p-1": "ticket-projeto" })[linearId] ?? null,
};
const changes = (patch: Partial<LinearHistoryEntryInput>, projectKey = "ENG") => linearHistoryChanges(entry(patch), resolver, projectKey);

describe("linearHistoryChanges", () => {
  it("entrada sem nenhuma mudança da lista dá lista vazia (ignorada)", () => {
    expect(changes({})).toEqual([]);
    expect(changes({ updatedDescription: false })).toEqual([]);
    // Objeto sem o id: o Linear só manda os `*Id` quando o campo mudou; o objeto sozinho não conta.
    expect(changes({ fromState: { name: "A", type: "started" } })).toEqual([]);
  });

  it("situação: nome e tipo das duas colunas; coluna apagada fica nula", () => {
    expect(changes({ fromStateId: "s1", toStateId: "s2", fromState: { name: "Todo", type: "unstarted" }, toState: { name: "Doing", type: "started" } })).toEqual([
      { field: "status", from: { name: "Todo", type: "unstarted" }, to: { name: "Doing", type: "started" } },
    ]);
    expect(changes({ fromStateId: "s1", toStateId: "s2", fromState: null, toState: { name: "Doing", type: "esquisito" } })).toEqual([{ field: "status", from: null, to: { name: "Doing", type: null } }]);
    expect(changes({ fromStateId: "s1", toStateId: "s1" })).toEqual([]);
  });

  it("responsável: pessoa casada, nome de exibição (nunca e-mail), apagado, ninguém", () => {
    expect(changes({ fromAssigneeId: null, toAssigneeId: "u-ana", toAssignee: { id: "u-ana", name: "Ana" } })).toEqual([{ field: "assignee", from: null, to: { personId: "person-ana" } }]);
    expect(changes({ fromAssigneeId: "u-bia", toAssigneeId: null, fromAssignee: { id: "u-bia", name: "Bia" } })).toEqual([{ field: "assignee", from: { name: "Bia" }, to: null }]);
    expect(changes({ fromAssigneeId: "u-x", toAssigneeId: "u-y", fromAssignee: null, toAssignee: { id: "u-y", name: "bia@empresa.com" } })).toEqual([
      { field: "assignee", from: { name: null }, to: { name: null } },
    ]);
  });

  it("prioridade convertida para a escala do TreePM; igual depois de converter não conta", () => {
    expect(changes({ fromPriority: 0, toPriority: 1 })).toEqual([{ field: "priority", from: 0, to: 400 }]);
    expect(changes({ fromPriority: null, toPriority: 4 })).toEqual([{ field: "priority", from: 0, to: 100 }]);
    expect(changes({ fromPriority: 2, toPriority: 2 })).toEqual([]);
    expect(changes({ fromPriority: 3, toPriority: null })).toEqual([]);
  });

  it("título: cortado em 200, sem caractere nulo nem quebra de linha", () => {
    const [change] = changes({ fromTitle: "a\u0000b\nc", toTitle: "x".repeat(500) });
    expect(change).toEqual({ field: "title", from: "ab c", to: "x".repeat(LINEAR_HISTORY_TITLE_MAX) });
    expect(changes({ fromTitle: "igual", toTitle: "igual" })).toEqual([]);
  });

  it("pai e projeto: o ticket local quando importado, senão só que mudou", () => {
    expect(changes({ fromParentId: null, toParentId: "i-pai" })).toEqual([{ field: "parent", from: null, to: { ticketId: "ticket-pai" } }]);
    expect(changes({ fromParentId: "i-fora", toParentId: null })).toEqual([{ field: "parent", from: { ticketId: null }, to: null }]);
    expect(changes({ fromProjectId: "p-x", toProjectId: "p-1" })).toEqual([{ field: "project", from: { ticketId: null }, to: { ticketId: "ticket-projeto" } }]);
  });

  it("descrição: só que mudou, sem texto; várias mudanças na ordem da lista", () => {
    expect(changes({ updatedDescription: true, toPriority: 1, fromPriority: 0, fromTitle: "a", toTitle: "b" })).toEqual([
      { field: "priority", from: 0, to: 400 },
      { field: "title", from: "a", to: "b" },
      { field: "description" },
    ]);
  });

  it("texto hostil em coluna, título e nome não vira menção de pessoa nem de ticket do projeto", () => {
    const hostile = ["[@Ana](person:abc)", "[x]: person:abc", '<a href="person:abc">', "<person:abc>", "veja ENG-12", "[a](person:x)" + "[".repeat(300)];
    for (const text of hostile) {
      const result = changes({ fromStateId: "s1", toStateId: "s2", fromState: { name: text, type: "started" }, fromTitle: text, toTitle: `!${text}`, fromAssigneeId: "u-z", fromAssignee: { id: "u-z", name: text } });
      expect(result.map((change) => change.field)).toEqual(["status", "assignee", "title"]);
      const strings: string[] = [];
      JSON.stringify(result, (_key, value: unknown) => (typeof value === "string" && strings.push(value), value));
      for (const value of strings) expect(mentionsPersonRaw(value), value).toBe(false);
      const title = result.find((change) => change.field === "title") as { from: string; to: string };
      expect(mentionsPersonRaw(title.from)).toBe(false);
      expect(mentionsPersonRaw(title.to)).toBe(false);
      expect(scanTicketKeys(title.from).filter((key) => key.key.startsWith("ENG-"))).toEqual([]);
    }
  });

  it("100.000 caracteres hostis em tempo linear e dentro dos tetos", () => {
    const patterns = ["]: ", "href= ", "< ", "[", "\t\n ", "[a](person:x)", "\u0000"];
    for (const unit of patterns) {
      const huge = unit.repeat(Math.ceil(100_000 / unit.length)).slice(0, 100_000);
      const start = performance.now();
      const result = changes({ fromStateId: "s1", toStateId: "s2", fromState: { name: huge, type: "started" }, fromTitle: huge, toTitle: `x${huge}`, fromAssigneeId: "u-z", fromAssignee: { id: "u-z", name: huge } });
      expect(performance.now() - start, unit).toBeLessThan(100);
      for (const change of result) {
        if (change.field === "title") expect(change.to.length).toBeLessThanOrEqual(LINEAR_HISTORY_TITLE_MAX);
        if (change.field === "status" && change.from !== null) expect(change.from.name.length).toBeLessThanOrEqual(LINEAR_HISTORY_NAME_MAX);
        expect(JSON.stringify(change)).not.toContain("\\u0000");
      }
    }
  });
});

describe("autor da entrada (a regra dos comentários)", () => {
  it("usuário, robô ou ninguém; nome sem forma de e-mail nem menção", () => {
    expect(linearHistoryAuthor(entry({ actor: { id: "u1", name: "Ana" } }))).toEqual({ kind: "user", id: "u1", name: "Ana" });
    expect(linearHistoryAuthor(entry({ botActor: { name: "GitHub" } }))).toEqual({ kind: "bot", id: null, name: "GitHub" });
    expect(linearHistoryAuthor(entry({}))).toBeNull();
    expect(linearHistoryAuthor(entry({ actor: { id: "u1", name: "ana@x.com" } }))).toEqual({ kind: "user", id: "u1", name: null });
    expect(mentionsPersonRaw(linearHistoryName("[@Ana](person:abc)") ?? "")).toBe(false);
    expect(linearHistoryName("x".repeat(500))?.length).toBe(LINEAR_HISTORY_NAME_MAX);
  });

  it("o predicado do banco (`@` seguido, a qualquer distância, de `.`): a mesma lista que o teste de banco confere contra o CHECK", () => {
    expect(LINEAR_HISTORY_NAME_CASES.filter((item) => linearHistoryNameRefused(item.name) !== item.refused)).toEqual([]);
    // Quebra de linha no meio: o `%` do LIKE casa qualquer caractere.
    expect(linearHistoryNameRefused("a@\nb.c")).toBe(true);
  });

  it("nome que o banco recusaria não é guardado: autor, robô e responsáveis de/para viram sem nome", () => {
    for (const { name, refused } of LINEAR_HISTORY_NAME_CASES) {
      expect(linearHistoryName(name), name).toBe(refused ? null : name);
      expect(linearHistoryAuthor(entry({ actor: { id: "u1", name } }))?.name, name).toBe(refused ? null : name);
      expect(linearHistoryAuthor(entry({ botActor: { name } }))?.name, name).toBe(refused ? null : name);
      expect(changes({ fromAssigneeId: "u-x", toAssigneeId: "u-y", fromAssignee: { id: "u-x", name }, toAssignee: { id: "u-y", name } }), name).toEqual([
        { field: "assignee", from: { name: refused ? null : name }, to: { name: refused ? null : name } },
      ]);
    }
    // O corte acontece antes da conferência: o que vale é o nome guardado.
    expect(linearHistoryName(`${"x".repeat(LINEAR_HISTORY_NAME_MAX)}@exemplo.com`)).toBeNull();
    expect(linearHistoryName(`Ana @ ${"x".repeat(LINEAR_HISTORY_NAME_MAX)}.io`)).toBe(`Ana @ ${"x".repeat(LINEAR_HISTORY_NAME_MAX - 6)}`);
  });

  it("colunas: pessoa casada, nome, ou o atual quando o e-mail não foi lido", () => {
    const author = { kind: "user" as const, id: "u1", name: "Ana" };
    expect(linearHistoryActor({ author, emailReadable: true, matchedPersonId: "p1", current: null })).toEqual({ actorPersonId: "p1", externalActorName: null });
    expect(linearHistoryActor({ author, emailReadable: true, matchedPersonId: null, current: { actorPersonId: "p1", externalActorName: null } })).toEqual({ actorPersonId: null, externalActorName: "Ana" });
    expect(linearHistoryActor({ author, emailReadable: false, matchedPersonId: null, current: { actorPersonId: "p1", externalActorName: null } })).toEqual({ actorPersonId: "p1", externalActorName: null });
    expect(linearHistoryActor({ author: { kind: "bot", id: null, name: "GitHub" }, emailReadable: true, matchedPersonId: "p1", current: null })).toEqual({ actorPersonId: null, externalActorName: "GitHub" });
    expect(linearHistoryActor({ author: null, emailReadable: true, matchedPersonId: null, current: null })).toEqual({ actorPersonId: null, externalActorName: null });
  });
});
