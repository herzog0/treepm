import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import i18n from "../i18n/index.js";
import { setTestLanguage } from "../test/i18n.js";
import type { ApiError } from "./client.js";
import { describeApiError, useDescribeApiError } from "./errorText.js";

/** A tabela de hoje (antes de sair do código), copiada aqui: o português não pode mudar nem uma letra. */
const CODES_PT: Record<string, string> = {
  team_name_taken: "Já existe um time com esse nome.",
  area_name_taken: "Já existe uma área com esse nome.",
  project_key_taken: "Já existe um projeto com essa chave.",
  person_inactive: "A pessoa não está mais na organização.",
  ticket_has_open_children: "Este ticket tem itens abertos. Conclua ou cancele os itens antes de concluí-lo.",
  ticket_cycle: "Um ticket não pode ser pai de si mesmo nem de um ancestral.",
  structure_busy: "Outra mudança na estrutura deste projeto está em andamento. Tente de novo em instantes.",
  project_archived: "O projeto está arquivado e só aceita leitura.",
  assistant_not_configured: "O assistente não está configurado neste ambiente. Crie o ticket manualmente.",
  assistant_unavailable: "O assistente não respondeu. Tente de novo; se continuar, crie o ticket manualmente.",
  conversation_closed: "Esta conversa já foi encerrada. Comece uma nova conversa.",
  conversation_changed: "A conversa mudou enquanto o assistente respondia. Mostramos a versão mais recente.",
  grouping_changed: "Algum desses tickets mudou de lugar. Procure de novo.",
  draft_required: "A conversa ainda não tem rascunho. Peça ao assistente para escrevê-lo antes de continuar.",
  ticket_has_no_items: "Este ticket ainda não tem itens.",
  github_unavailable: "O GitHub não respondeu. Tente de novo em instantes.",
  not_connected: "A organização não está ligada ao GitHub.",
  installation_unavailable: "A instalação do app no GitHub não está disponível.",
  repository_already_linked: "Este repositório já está ligado.",
  repository_not_found: "O app não tem acesso a este repositório.",
  person_without_project_access: "A pessoa ainda não tem acesso ao projeto. Conceda um papel no projeto antes de atribuir.",
};
const KINDS_PT: Record<ApiError["kind"], string> = {
  unauthenticated: "Sua sessão expirou. Entre novamente.",
  forbidden: "Você não tem permissão para fazer isso.",
  not_found: "Não encontramos esse item. Ele pode ter sido removido.",
  conflict: "Esta alteração conflita com o estado atual. Recarregue e tente novamente.",
  invalid: "Os dados informados não são válidos.",
  server_error: "O servidor encontrou um erro. Tente de novo; se continuar, avise quem administra.",
  unavailable: "A API está indisponível. Tente novamente em instantes.",
};
const REMOVE_PT = "Este ticket tem itens. Mova ou remova os itens antes de removê-lo.";

const cases = (): ApiError[] => [
  ...Object.keys(CODES_PT).map((code) => ({ kind: "conflict", code }) as ApiError),
  ...(Object.keys(KINDS_PT) as ApiError["kind"][]).map((kind) => ({ kind }) as ApiError),
];
const expectedPt = (e: ApiError) => (e.code ? CODES_PT[e.code] : undefined) ?? KINDS_PT[e.kind];

describe("describeApiError (pt-BR)", () => {
  it("devolve exatamente o texto de hoje para cada código e cada tipo", () => {
    for (const e of cases()) expect(describeApiError(i18n.t, e)).toBe(expectedPt(e));
  });
  it("código desconhecido cai na mensagem do tipo", () => {
    expect(describeApiError(i18n.t, { kind: "conflict", code: "unknown_code" })).toBe(KINDS_PT.conflict);
  });
  it("a remoção de ticket com filhos tem frase própria", () => {
    expect(describeApiError(i18n.t, { kind: "conflict", code: "ticket_has_children" }, "remove")).toBe(REMOVE_PT);
    expect(describeApiError(i18n.t, { kind: "conflict", code: "ticket_has_children" })).toBe(KINDS_PT.conflict);
  });
});

describe.each(["en", "es-MX"] as const)("describeApiError (%s)", (language) => {
  it("devolve texto que não é o português, para cada código e cada tipo, e para a remoção", async () => {
    await setTestLanguage(language);
    for (const e of cases()) {
      const text = describeApiError(i18n.t, e);
      expect(text).not.toBe(expectedPt(e));
      expect(text).not.toMatch(/^api:|^errors\./);
    }
    const remove = describeApiError(i18n.t, { kind: "conflict", code: "ticket_has_children" }, "remove");
    expect(remove).not.toBe(REMOVE_PT);
    expect(remove).not.toBe(describeApiError(i18n.t, { kind: "conflict" }));
  });
  it("código desconhecido cai na mensagem do tipo", async () => {
    await setTestLanguage(language);
    expect(describeApiError(i18n.t, { kind: "conflict", code: "unknown_code" })).toBe(describeApiError(i18n.t, { kind: "conflict" }));
  });
});

describe("useDescribeApiError", () => {
  it("troca o texto quando o idioma muda, sem remontar", async () => {
    const { result } = renderHook(() => useDescribeApiError());
    const error: ApiError = { kind: "conflict", code: "team_name_taken" };
    expect(result.current(error)).toBe("Já existe um time com esse nome.");
    await act(async () => {
      await i18n.changeLanguage("en");
    });
    expect(result.current(error)).toBe("A team with that name already exists.");
    await act(async () => {
      await i18n.changeLanguage("es-MX");
    });
    expect(result.current(error)).toBe("Ya existe un equipo con ese nombre.");
  });
});
