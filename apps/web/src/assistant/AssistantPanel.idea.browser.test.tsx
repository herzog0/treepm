import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import "../command/command.css";
import type { ApiClient, DraftPreview } from "../api/client.js";
import { makeClient, makeConversation, makeProject, makeTicket, ok } from "../test/fakes.js";
import { AssistantPanel } from "./AssistantPanel.js";

// ADR 0044, adendo (TREEPM-242), em navegador real: o controle «Registrar como ideia» alcançável pelo teclado e com alvo de 44 px em tela estreita.
const project = makeProject("p1", "TREEPM", "TreePM");

function makeClientWith(): ApiClient {
  const preview: DraftPreview = { title: "Botão play", description: "x", quote: "", children: [], idea: false, unknownKeys: [], descriptionTooLong: false };
  const conversation = makeConversation("c1", "p1", { draft: { title: "Botão play", description: "Organizado.", children: [], idea: false } });
  const client = makeClient({ projects: [project] });
  Object.assign(client, {
    listConversations: vi.fn(async () => ok([{ ...conversation, messages: undefined }])),
    getConversation: vi.fn(async () => ok(conversation)),
    getConversationPreview: vi.fn(async () => ok(preview)),
  });
  return client;
}

async function mount() {
  return render(
    <main className="tenant-map" style={{ position: "fixed", inset: 0, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "12px 0" }}>
      <div className="command-bar is-open">
        <AssistantPanel client={makeClientWith()} projects={[project]} initialProjectId="p1" tickets={{ p1: [makeTicket("t1", "p1", 1, "Design", { key: "TREEPM-12" })] }} expanded resume
          onCollapse={() => undefined} onProgress={() => undefined} onCreated={() => undefined} onManualCreate={() => undefined} onDraftChange={() => undefined} onChanged={() => undefined} registerPicker={() => undefined} />
      </div>
    </main>,
  );
}

describe("«Registrar como ideia» em navegador real", () => {
  for (const { size, width, height } of [{ size: "1440x900", width: 1440, height: 900 }, { size: "390x844", width: 390, height: 844 }]) {
    it(`é visível, marca pelo teclado e cabe na tela (${size})`, async () => {
      await page.viewport(width, height);
      const screen = await mount();
      const box = screen.getByRole("checkbox", { name: "Registrar como ideia" });
      await expect.element(box).toBeVisible();
      const input = box.element() as HTMLInputElement;
      input.focus();
      await userEvent.keyboard(" ");
      expect(input.checked).toBe(true);
      await userEvent.keyboard(" ");
      expect(input.checked).toBe(false);
      const label = input.closest("label")!;
      const rect = label.getBoundingClientRect();
      if (width < 720) expect(rect.height).toBeGreaterThanOrEqual(44);
      const scroll = document.querySelector<HTMLElement>(".assistant-scroll")!;
      expect(scroll.scrollWidth).toBeLessThanOrEqual(scroll.clientWidth + 1);
    });
  }
});
