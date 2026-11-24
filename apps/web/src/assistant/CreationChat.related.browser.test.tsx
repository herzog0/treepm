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

// ADR 0052, fatia 2, em navegador real: o aviso de pedido que já existe e a lista de relacionados, em 1440 e 390.
const SIZES = [{ size: "1440x900", width: 1440, height: 900 }, { size: "390x844", width: 390, height: 844 }];
const project = makeProject("p1", "TREEPM", "TreePM");
const duplicate = { id: "t7", key: "TREEPM-139", title: "Importar de GitHub, Jira e Linear, com categorização automática opcional", status: "todo" };
const related = [
  { ...duplicate, status: "todo", path: [{ id: "t1", title: "Tickets no mapa" }] },
  { id: "t8", key: "TREEPM-144", title: "Reimportar sem duplicar: guardar a origem de cada ticket", status: "todo", path: [] },
];

function clientWith(): ApiClient {
  const client = makeClient({ projects: [project] });
  const conversation = makeConversation("c1", "p1", { draft: { title: "Sincronizar tickets com Jira, GitHub, Linear recebendo o diff", description: "Receber só o diff.", children: [] } });
  Object.assign(client, {
    listConversations: vi.fn(async () => ok([{ ...conversation, messages: undefined }])),
    getConversation: vi.fn(async () => ok(conversation)),
    openConversation: vi.fn(() => new Promise(() => undefined)),
    getConversationPreview: vi.fn(async () => ok({ title: conversation.draft!.title, description: "Receber só o diff.", quote: "", children: [], idea: false, unknownKeys: [], descriptionTooLong: false })),
    findPlacement: vi.fn(async () => ok(makePlacement({ destination: { parentId: "t1", path: [{ id: "t1", title: "Tickets no mapa" }] }, related, duplicate }))),
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

describe("o aviso de duplicado em navegador real", () => {
  for (const { size, width, height } of SIZES) {
    it(`aparece antes do botão de criar, com alvos de 44 px em tela estreita e sem rolagem lateral (${size})`, async () => {
      await page.viewport(width, height);
      const screen = await mount();
      await screen.getByRole("button", { name: "Procurar o lugar" }).click();
      const notice = screen.getByRole("alert");
      await expect.element(notice).toBeVisible();
      await expect.element(screen.getByText(/Já existe um ticket que parece ser este pedido: TREEPM-139/)).toBeVisible();
      const create = screen.getByRole("button", { name: "Criar aqui" });
      await expect.element(create).toBeDisabled();
      const noticeBox = notice.element().closest(".assistant-duplicate")!.getBoundingClientRect();
      const createBox = create.element().getBoundingClientRect();
      expect(noticeBox.bottom).toBeLessThanOrEqual(createBox.top + 1);
      for (const name of ["Abrir o ticket", "Criar mesmo assim"]) {
        const box = screen.getByRole("button", { name }).element().getBoundingClientRect();
        if (width <= 720) expect(box.height).toBeGreaterThanOrEqual(44);
      }
      const scroll = document.querySelector<HTMLElement>(".assistant-scroll")!;
      expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth + 1);
      await screen.getByRole("button", { name: "Criar mesmo assim" }).click();
      await expect.element(screen.getByRole("button", { name: "Criar aqui" })).toBeEnabled();
    });

    it(`a lista de relacionados cabe na tela e cada item abre o ticket (${size})`, async () => {
      await page.viewport(width, height);
      const screen = await mount();
      await screen.getByRole("button", { name: "Procurar o lugar" }).click();
      const list = screen.getByRole("region", { name: "Relacionados" });
      await expect.element(list).toBeVisible();
      for (const button of Array.from(list.element().querySelectorAll("button"))) {
        const box = button.getBoundingClientRect();
        expect(box.right).toBeLessThanOrEqual(window.innerWidth + 1);
        if (width <= 720) expect(box.height).toBeGreaterThanOrEqual(44);
      }
    });
  }
});
