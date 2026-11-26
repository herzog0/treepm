import { describe, expect, it } from "vitest";
import { linearRelationApplied, linearRelationKey, mapLinearRelation, relatedPair, removalCarriesOver, sameRelationEnds } from "./linear-relations.js";

// Relações do Linear (ADR 0061, seções 3 e 4; TREEPM-478): o que cada tipo vira no TreePM e a identidade da origem.

describe("mapLinearRelation", () => {
  it("A bloqueia B vira B depende de A", () => {
    expect(mapLinearRelation("blocks", "A", "B")).toEqual({ kind: "depends_on", from: "B", to: "A" });
  });

  it("related e duplicate viram related, com as pontas em ordem (simétrica)", () => {
    expect(mapLinearRelation("related", "E", "D")).toEqual({ kind: "related", from: "D", to: "E" });
    expect(mapLinearRelation("duplicate", "F", "G")).toEqual({ kind: "related", from: "F", to: "G" });
    expect(mapLinearRelation("duplicate", "G", "F")).toEqual(mapLinearRelation("related", "F", "G"));
  });

  it("similar, tipo desconhecido e a issue ligada a si mesma são ignorados", () => {
    expect(mapLinearRelation("similar", "A", "B")).toBeNull();
    expect(mapLinearRelation("quebra", "A", "B")).toBeNull();
    expect(mapLinearRelation("BLOCKS", "A", "B")).toBeNull();
    expect(mapLinearRelation("blocks", "A", "A")).toBeNull();
  });
});

describe("linearRelationKey", () => {
  it("muda quando o tipo do TreePM ou as pontas mudam no mesmo id (trocada no Linear = origem nova)", () => {
    const blocks = linearRelationKey("r1", mapLinearRelation("blocks", "A", "B") as never);
    const related = linearRelationKey("r1", mapLinearRelation("related", "A", "B") as never);
    const otherEnd = linearRelationKey("r1", mapLinearRelation("blocks", "A", "C") as never);
    expect(new Set([blocks, related, otherEnd]).size).toBe(3);
  });

  it("related ↔ duplicate no mesmo id e na mesma dupla não muda nada", () => {
    expect(linearRelationKey("r1", mapLinearRelation("related", "A", "B") as never)).toBe(linearRelationKey("r1", mapLinearRelation("duplicate", "B", "A") as never));
  });

  it("cabe no limite do id externo (200) com ids do tamanho de um UUID", () => {
    const uuid = "0190a0b0-0000-7000-8000-000000000001";
    expect(linearRelationKey(uuid, mapLinearRelation("blocks", uuid, uuid.replace(/1$/, "2")) as never).length).toBeLessThanOrEqual(200);
  });
});

describe("relatedPair", () => {
  it("põe o menor primeiro", () => {
    expect(relatedPair("b", "a")).toEqual(["a", "b"]);
    expect(relatedPair("a", "b")).toEqual(["a", "b"]);
  });
});

describe("linearRelationApplied e sameRelationEnds (R2: edição no Linear e ticket apagado aqui)", () => {
  it("guarda o tipo do TreePM, os ids do Linear e os tickets das duas pontas", () => {
    const mapped = mapLinearRelation("blocks", "i-1", "i-2");
    expect(linearRelationApplied("r-1", "i-1", "i-2", mapped as NonNullable<typeof mapped>, { issueTicketId: "t-1", relatedIssueTicketId: "t-2" })).toEqual({
      type: "depends_on",
      relationId: "r-1",
      issueId: "i-1",
      relatedIssueId: "i-2",
      issueTicketId: "t-1",
      relatedIssueTicketId: "t-2",
    });
  });

  it("as pontas são as mesmas só se os dois tickets guardados são os de agora; sem o que comparar, vale como as mesmas", () => {
    const applied = { type: "related", relationId: "r", issueId: "i-1", relatedIssueId: "i-2", issueTicketId: "t-1", relatedIssueTicketId: "t-2" };
    expect(sameRelationEnds(applied, { issueTicketId: "t-1", relatedIssueTicketId: "t-2" })).toBe(true);
    expect(sameRelationEnds(applied, { issueTicketId: "t-9", relatedIssueTicketId: "t-2" })).toBe(false);
    expect(sameRelationEnds(applied, { issueTicketId: "t-1", relatedIssueTicketId: "t-9" })).toBe(false);
    expect(sameRelationEnds(applied, { issueTicketId: undefined, relatedIssueTicketId: "t-2" })).toBe(false);
    expect(sameRelationEnds({ type: "related" }, { issueTicketId: "t-1", relatedIssueTicketId: "t-2" })).toBe(true);
    expect(sameRelationEnds(null, { issueTicketId: "t-1", relatedIssueTicketId: "t-2" })).toBe(true);
  });
});

describe("removalCarriesOver (R3: removida aqui só passa à forma nova no MESMO par)", () => {
  const removed = { type: "depends_on", relationId: "r", issueId: "i-1", relatedIssueId: "i-2", issueTicketId: "t-1", relatedIssueTicketId: "t-2" };
  const now = { issueTicketId: "t-1", relatedIssueTicketId: "t-2" };

  it("inversão de sentido ou troca de tipo (os mesmos dois tickets, em qualquer ordem): herda", () => {
    expect(removalCarriesOver(removed, now, { issueTicketId: "t-1", relatedIssueTicketId: "t-2" })).toBe(true);
    expect(removalCarriesOver(removed, now, { issueTicketId: "t-2", relatedIssueTicketId: "t-1" })).toBe(true);
  });

  it("outro par (troca de ponta): é relação nova, não herda", () => {
    expect(removalCarriesOver(removed, now, { issueTicketId: "t-1", relatedIssueTicketId: "t-3" })).toBe(false);
    expect(removalCarriesOver(removed, now, { issueTicketId: "t-3", relatedIssueTicketId: "t-1" })).toBe(false);
  });

  it("a forma removida perdeu um dos tickets (apagado e importado de novo): não herda", () => {
    expect(removalCarriesOver(removed, { issueTicketId: "t-9", relatedIssueTicketId: "t-2" }, { issueTicketId: "t-9", relatedIssueTicketId: "t-2" })).toBe(false);
  });

  it("origem antiga sem os tickets guardados: compara só os tickets de agora", () => {
    expect(removalCarriesOver({ type: "depends_on" }, now, { issueTicketId: "t-2", relatedIssueTicketId: "t-1" })).toBe(true);
    expect(removalCarriesOver({ type: "depends_on" }, now, { issueTicketId: "t-2", relatedIssueTicketId: "t-3" })).toBe(false);
  });

  it("ponta sem ticket de nenhum lado: não herda", () => {
    expect(removalCarriesOver({ type: "depends_on" }, { issueTicketId: undefined, relatedIssueTicketId: "t-2" }, { issueTicketId: undefined, relatedIssueTicketId: "t-2" })).toBe(false);
  });
});
