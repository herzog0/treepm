import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { TicketDetail } from "../api/client.js";
import { makePanelMe } from "../panel/testing.js";
import { makeClient, makePerson, makeProject, makeTicket, ok } from "../test/fakes.js";
import { setTestLanguage } from "../test/i18n.js";
import { TicketPage } from "./TicketPage.js";

const project = makeProject("p1", "ENG", "Engenharia");
const summary = makeTicket("t1", "p1", 1, "Importado", { key: "ENG-1" });

function setup(externalSource: TicketDetail["externalSource"] | undefined) {
  const detail: TicketDetail = { ...summary, description: "", mentionedBy: [], dependsOn: [], blocks: [], createdByPersonId: "person-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z", ...(externalSource === undefined ? {} : { externalSource }) };
  const client = makeClient({ projects: [project], tickets: { p1: [summary] }, people: [makePerson("person-1", "Ana"), makePerson("person-2", "Beto")] });
  Object.assign(client, { getTicket: vi.fn(async () => ok(detail)) });
  render(
    <TicketPage client={client} me={makePanelMe("admin")} projects={[project]} ticketId="t1" creating={null}
      onOpenTicket={vi.fn()} onClose={vi.fn()} onChanged={vi.fn()} onRemoved={vi.fn()} onStartCreate={vi.fn()} onCancelCreate={vi.fn()} onCreated={vi.fn()} />,
  );
}
const ISSUE = "https://linear.app/acme/issue/ENG-123/titulo";

describe("TicketPage › Ver no Linear (ADR 0060)", () => {
  it("ticket vindo de uma issue: atalho com a chave, em outra aba e sem referer", async () => {
    setup({ provider: "linear", key: "ENG-123", url: ISSUE });
    const link = await screen.findByRole("link", { name: "Ver ENG-123 no Linear (abre em outra aba)" });
    expect(link).toHaveTextContent("Ver no Linear · ENG-123");
    expect(link).toHaveAttribute("href", ISSUE);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("ticket vindo de um projeto do Linear (sem chave): só 'Ver no Linear'", async () => {
    setup({ provider: "linear", key: null, url: "https://linear.app/acme/project/lancamento-abc" });
    const link = await screen.findByRole("link", { name: "Ver no Linear (abre em outra aba)" });
    expect(link).toHaveTextContent(/^Ver no Linear$/);
  });

  it("origem sem endereço (url nula): mostra 'Linear · ENG-123' sem link", async () => {
    setup({ provider: "linear", key: "ENG-123", url: null });
    expect(await screen.findByText("Linear · ENG-123")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Linear/ })).not.toBeInTheDocument();
  });

  it("origem sem endereço e sem chave: só 'Linear', sem link", async () => {
    setup({ provider: "linear", key: null, url: null });
    expect(await screen.findByText("Linear", { selector: ".ticket-linear-plain" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Linear/ })).not.toBeInTheDocument();
  });

  it.each([
    "http://linear.app/acme/issue/ENG-1",
    "https://linear.app.evil.example/acme/issue/ENG-1",
    "https://evil.example/linear.app/issue",
    "javascript:alert(1)",
    "https://user@linear.app/x",
    "not a url",
  ])("endereço que não é do Linear não vira link: %s", async (url) => {
    setup({ provider: "linear", key: "ENG-9", url });
    await screen.findByText("Importado");
    await waitFor(() => expect(screen.getByRole("button", { name: "Copiar link" })).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /Linear/ })).not.toBeInTheDocument();
  });

  it("ticket sem origem externa não tem o atalho", async () => {
    setup(null);
    await screen.findByText("Importado");
    expect(screen.queryByRole("link", { name: /Linear/ })).not.toBeInTheDocument();
  });

  describe("não encontrada no Linear", () => {
    const missing = { provider: "linear" as const, key: "ENG-123", url: ISSUE, missingSince: "2026-11-20T15:00:00.000Z" };

    it("com missingSince, ao lado do atalho: 'Não encontrada no Linear desde <data>'", async () => {
      setup(missing);
      const note = await screen.findByText(/Não encontrada no Linear desde/);
      expect(note).toHaveTextContent("Não encontrada no Linear desde 20 de novembro de 2026");
      expect(screen.getByRole("link", { name: "Ver ENG-123 no Linear (abre em outra aba)" })).toBeInTheDocument();
      // O sinal não depende só de cor: tem ícone (decorativo) e texto.
      expect(note.closest(".ticket-linear-missing")!.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    });

    it("também sem endereço (só o texto da origem)", async () => {
      setup({ ...missing, url: null });
      expect(await screen.findByText(/Não encontrada no Linear desde/)).toBeInTheDocument();
      expect(screen.getByText("Linear · ENG-123")).toBeInTheDocument();
    });

    it.each([[null], [undefined]])("sem missingSince (%s), nenhum aviso", async (value) => {
      setup({ provider: "linear", key: "ENG-123", url: ISSUE, missingSince: value });
      await screen.findByRole("link", { name: /Ver ENG-123 no Linear/ });
      expect(screen.queryByText(/Não encontrada no Linear/)).not.toBeInTheDocument();
    });

    it.each([
      ["en", "Not found in Linear since"],
      ["es-MX", "No encontrada en Linear desde"],
    ] as const)("em %s", async (language, text) => {
      await setTestLanguage(language);
      try {
        setup(missing);
        expect(await screen.findByText(new RegExp(text))).toBeInTheDocument();
      } finally {
        await setTestLanguage("pt-BR");
      }
    });
  });
});

describe("TicketPage › a origem no Linear (ADR 0061)", () => {
  const base = { provider: "linear" as const, key: "ENG-123", url: ISSUE };

  it("criador casado com uma pessoa do TreePM: 'Criado no Linear em <data>, por <nome>'", async () => {
    setup({ ...base, createdAt: "2026-03-03T12:00:00.000Z", creator: { personId: "person-2" } });
    expect(await screen.findByText("Criado no Linear em 3 de março de 2026, por Beto")).toBeInTheDocument();
  });

  it("criador que não é do TreePM: o nome vem com '(no Linear)'", async () => {
    setup({ ...base, createdAt: "2026-03-03T12:00:00.000Z", creator: { name: "Carla" } });
    expect(await screen.findByText("Criado no Linear em 3 de março de 2026, por Carla (no Linear)")).toBeInTheDocument();
  });

  it("sem criador: só a data", async () => {
    setup({ ...base, createdAt: "2026-03-03T12:00:00.000Z", creator: null });
    expect(await screen.findByText("Criado no Linear em 3 de março de 2026")).toBeInTheDocument();
  });

  it("criador cuja pessoa não está na lista: cai para só a data, sem inventar nome", async () => {
    setup({ ...base, createdAt: "2026-03-03T12:00:00.000Z", creator: { personId: "person-99" } });
    expect(await screen.findByText("Criado no Linear em 3 de março de 2026")).toBeInTheDocument();
  });

  it("início, conclusão e cancelamento aparecem em texto secundário quando existem", async () => {
    setup({ ...base, createdAt: "2026-03-03T12:00:00.000Z", startedAt: "2026-03-05T12:00:00.000Z", completedAt: "2026-03-09T12:00:00.000Z", canceledAt: "2026-03-10T12:00:00.000Z", creator: null });
    expect(await screen.findByText("Iniciado em 5 de março de 2026")).toBeInTheDocument();
    expect(screen.getByText("Concluído em 9 de março de 2026")).toBeInTheDocument();
    expect(screen.getByText("Cancelado em 10 de março de 2026")).toBeInTheDocument();
  });

  it("só o que existe: sem datas novas nada é escrito", async () => {
    setup({ ...base, createdAt: null, startedAt: null, completedAt: null, canceledAt: null, creator: null });
    await screen.findByRole("link", { name: /Ver ENG-123 no Linear/ });
    expect(screen.queryByText(/no Linear em|Iniciado em|Concluído em|Cancelado em/)).not.toBeInTheDocument();
  });

  it("API antiga (sem os campos novos) e ticket sem origem: nada é escrito", async () => {
    setup(base);
    await screen.findByRole("link", { name: /Ver ENG-123 no Linear/ });
    expect(screen.queryByText(/Criado no Linear/)).not.toBeInTheDocument();
  });

  it("ticket sem origem não mostra nenhuma dessas linhas", async () => {
    setup(null);
    await screen.findByText("Importado");
    expect(screen.queryByText(/Criado no Linear|Iniciado em|Concluído em|Cancelado em/)).not.toBeInTheDocument();
  });

  it.each([
    ["en", "Created in Linear on March 3, 2026, by Beto", "Started on March 5, 2026"],
    ["es-MX", "Creado en Linear el 3 de marzo de 2026, por Beto", "Iniciado el 5 de marzo de 2026"],
  ] as const)("em %s", async (language, created, started) => {
    await setTestLanguage(language);
    try {
      setup({ ...base, createdAt: "2026-03-03T12:00:00.000Z", startedAt: "2026-03-05T12:00:00.000Z", creator: { personId: "person-2" } });
      expect(await screen.findByText(created)).toBeInTheDocument();
      expect(screen.getByText(started)).toBeInTheDocument();
    } finally {
      await setTestLanguage("pt-BR");
    }
  });
});
