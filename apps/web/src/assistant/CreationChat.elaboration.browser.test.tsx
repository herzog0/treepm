import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import "../command/command.css";
import type { ApiClient } from "../api/client.js";
import { makeClient, makeConversation, makePlacement, makeProject, makeTicket, ok } from "../test/fakes.js";
import { ChatHarness } from "../test/mountChat.js";

// ADR 0052, fatia 3, em navegador real: as tarefas sugeridas e as ligações propostas, em 1440 e 390.
const SIZES = [{ size: "1440x900", width: 1440, height: 900 }, { size: "390x844", width: 390, height: 844 }];
const project = makeProject("p1", "TREEPM", "TreePM");
const related = [{ id: "t8", key: "TREEPM-144", title: "Reimportar sem duplicar: guardar a origem de cada ticket", status: "todo", path: [] }];

function clientWith(): ApiClient {
  const client = makeClient({ projects: [project] });
  const conversation = makeConversation("c1", "p1", { draft: { title: "Sincronizar tickets com Jira, GitHub, Linear recebendo o diff", description: "Receber só o diff.", children: [] } });
  Object.assign(client, {
    listConversations: vi.fn(async () => ok([{ ...conversation, messages: undefined }])),
    getConversation: vi.fn(async () => ok(conversation)),
    openConversation: vi.fn(() => new Promise(() => undefined)),
    getConversationPreview: vi.fn(async () => ok({ title: conversation.draft!.title, description: "Receber só o diff.", quote: "", children: [], idea: false, unknownKeys: [], descriptionTooLong: false })),
    findPlacement: vi.fn(async () => ok(makePlacement({ destination: { parentId: "t1", path: [{ id: "t1", title: "Tickets no mapa" }] }, related }))),
    getElaboration: vi.fn(async () =>
      ok({
        links: [{ de: "pai", dependeDe: "TREEPM-144", dependeDeTitle: related[0]!.title, motivo: "Sem a origem guardada não dá para pedir só o diff" }],
        suggested: [
          { title: "Guardar o cursor da última sincronização de cada integração", description: "", motivo: "Sem o cursor não há diff" },
          { title: "Cadastrar o token de cada provedor", description: "", motivo: "Cada provedor exige o próprio token" },
        ],
        unavailable: null,
      })),
  });
  return client;
}

async function mount() {
  return render(
    <main className="tenant-map" style={{ position: "fixed", inset: 0, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "12px 0" }}>
      <div className="command-bar is-open">
        <ChatHarness client={clientWith()} projects={[project]} initialProjectId="p1" tickets={{ p1: [makeTicket("t1", "p1", 1, "Tickets no mapa", { key: "TREEPM-1" })] }} resume
          onCreated={() => undefined} onOpenExisting={() => undefined} onManualCreate={() => undefined} onDraftChange={() => undefined} onChanged={() => undefined} registerPicker={() => undefined} />
      </div>
    </main>,
  );
}

afterEach(async () => {
  await page.viewport(1280, 720);
});

describe("as sugeridas e as ligações em navegador real", () => {
  for (const { size, width, height } of SIZES) {
    it(`os dois grupos cabem na tela, sem rolagem lateral, com alvos de 44 px em tela estreita (${size})`, async () => {
      await page.viewport(width, height);
      const screen = await mount();
      await screen.getByRole("button", { name: "Procurar o lugar" }).click();
      const suggested = screen.getByRole("region", { name: "Sugeridas pelo assistente" });
      const links = screen.getByRole("region", { name: "Ligações propostas" });
      await expect.element(suggested).toBeVisible();
      await expect.element(links).toBeVisible();
      const targets = [
        ...Array.from(suggested.element().querySelectorAll("button")),
        ...Array.from(links.element().querySelectorAll("button, label")),
        links.element().querySelector("input")!,
      ];
      for (const target of targets) {
        const box = target.getBoundingClientRect();
        expect(box.right).toBeLessThanOrEqual(window.innerWidth + 1);
        if (width <= 720) expect(box.height + (target instanceof HTMLInputElement ? 2 * 10 : 0)).toBeGreaterThanOrEqual(44);
      }
      const scroll = document.querySelector<HTMLElement>(".assistant-scroll")!;
      expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth + 1);
      // As sugeridas vêm antes das ligações e as duas, depois do rascunho.
      const draftBox = screen.getByRole("region", { name: "Rascunho do ticket" }).element().getBoundingClientRect();
      expect(suggested.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(draftBox.bottom - 1);
      expect(links.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(suggested.element().getBoundingClientRect().bottom - 1);
      await screen.getByRole("button", { name: "Tirar todas" }).click();
      await expect.element(screen.getByRole("region", { name: "Ligações propostas" })).toBeVisible();
    });
  }
});
