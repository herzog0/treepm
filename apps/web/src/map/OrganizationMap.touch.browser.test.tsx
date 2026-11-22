import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { cdp, page } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

// Toque de verdade no mapa (TREEPM-230), num viewport de celular: o toque é emulado pelo CDP (Input.dispatchTouchEvent),
// que gera Pointer Events com pointerType "touch" e o clique sintético de um tap, como no Chrome de um aparelho.
const project = makeProject("p1", "ALFA", "Projeto Alfa");

function Harness() {
  const [openId, setOpenId] = useState<string | null>(null);
  const [client] = useState(() => makeTreeClient({
    projects: [project],
    tickets: { p1: [makeTicket("t1", "p1", 1, "Acesso e conta", { key: "ALFA-1", status: "in_progress" }), makeTicket("t2", "p1", 2, "Publicação", { key: "ALFA-2" })] },
    people: [makePerson("person-1", "Ana")],
  }));
  return (
    <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
      <OrganizationMap client={client} me={makePanelMe("admin")} openTicketId={openId} onOpenTicketChange={setOpenId} />
    </main>
  );
}
const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));
// Dois quadros: o primeiro aplica o estado do React que o evento agendou, o segundo deixa a geometria dos cartões chegar ao DOM.
const frame = async () => {
  for (let count = 0; count < 2; count += 1) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
};

interface Finger { id: number; x: number; y: number }

/** Coordenadas do CDP são as da página de cima; o teste roda num iframe, então soma o deslocamento e a escala dele. */
function toPage(x: number, y: number) {
  const iframe = window.frameElement?.getBoundingClientRect();
  const scale = iframe && window.frameElement ? iframe.width / window.innerWidth : 1;
  return { x: (iframe?.left ?? 0) + x * scale, y: (iframe?.top ?? 0) + y * scale };
}
const asPoints = (fingers: Finger[]) => fingers.map(({ id, x, y }) => ({ id, ...toPage(x, y) }));
async function dispatch(type: "touchStart" | "touchMove" | "touchEnd", fingers: Finger[]) {
  await cdp().send("Input.dispatchTouchEvent", { type, touchPoints: asPoints(fingers) });
  await frame();
}
/** Dedos que descem, andam em passos e sobem (touchEnd sem pontos solta todos). */
async function gesture(start: Finger[], end: Finger[], steps = 8, release = true) {
  await dispatch("touchStart", start);
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    await dispatch("touchMove", start.map((f, index) => ({ id: f.id, x: f.x + (end[index]!.x - f.x) * t, y: f.y + (end[index]!.y - f.y) * t })));
  }
  if (release) await dispatch("touchEnd", []);
}

/** Wheel de mouse no ponto dado (coordenadas do iframe): o caminho de zoom que a pinça tem de reproduzir. */
async function wheel(at: { x: number; y: number }, deltaY: number) {
  const point = toPage(at.x, at.y);
  await cdp().send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY });
}

const card = (label: RegExp) => [...document.querySelectorAll("button")].find((b) => label.test(b.getAttribute("aria-label") ?? b.textContent ?? ""))!.getBoundingClientRect();
const center = (rect: DOMRect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
// Canto superior esquerdo dos dois cartões: a posição de um cartão é linear na escala e na câmera (o tamanho dele não é: muda com o nível de detalhe).
const corner = (rect: DOMRect) => ({ x: rect.left, y: rect.top });
const spread = () => {
  const a = corner(card(/ALFA-1 · Acesso e conta/));
  const b = corner(card(/ALFA-2 · Publicação/));
  return { a, b, distance: Math.hypot(a.x - b.x, a.y - b.y) };
};
const stageRect = () => document.querySelector("[aria-label='Mapa da organização']")!.getBoundingClientRect();
const ticketPageOpen = () => document.querySelector("[aria-label='Página do ticket']") !== null;

async function openMap() {
  // A preparação (abrir o projeto e explorar o ramo) usa o mouse num viewport largo, onde o painel lateral não cobre o mapa;
  // depois o viewport vira o de um celular e o painel é fechado, e só então o toque é ligado.
  await page.viewport(1440, 900);
  const screen = await render(<Harness />);
  await screen.getByRole("button", { name: /ALFA · Projeto Alfa/ }).click();
  await screen.getByRole("button", { name: "Explorar ramo" }).click();
  await settle();
  await page.viewport(390, 844);
  await settle(300);
  [...document.querySelectorAll<HTMLButtonElement>("aside.side-panel button")].find((button) => button.textContent?.trim() === "Fechar")?.click();
  await settle(500);
  // O ramo do projeto é enquadrado de novo no viewport estreito: reset da câmera e "+" (mouse) até os dois cartões aparecerem inteiros.
  const click = (label: string) => document.querySelector<HTMLButtonElement>(`.spatial-toolbar button[aria-label='${label}']`)!.click();
  click("Restaurar enquadramento");
  await settle(400);
  // O wheel (mouse) aproxima o ponto entre os dois cartões até ficarem legíveis; o toque só entra depois.
  for (let step = 0; step < 30 && card(/ALFA-2 · Publicação/).width < 90; step += 1) {
    const a = center(card(/ALFA-1 · Acesso e conta/));
    const b = center(card(/ALFA-2 · Publicação/));
    const at = toPage((a.x + b.x) / 2, (a.y + b.y) / 2);
    await cdp().send("Input.dispatchMouseEvent", { type: "mouseWheel", x: at.x, y: at.y, deltaX: 0, deltaY: -300 });
    await settle(150);
  }
  await settle(400);
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  return screen;
}

afterEach(async () => {
  await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
});

describe("mapa no toque, em navegador real (390×844)", () => {
  it("pinça abrindo amplia na proporção dos dedos e ancora no ponto entre eles (desfeita por um wheel inverso no mesmo ponto)", async () => {
    await openMap();
    const before = spread();
    const mid = { x: (before.a.x + before.b.x) / 2, y: (before.a.y + before.b.y) / 2 };
    await gesture([{ id: 1, x: mid.x - 30, y: mid.y }, { id: 2, x: mid.x + 30, y: mid.y }], [{ id: 1, x: mid.x - 60, y: mid.y }, { id: 2, x: mid.x + 60, y: mid.y }]);
    await settle(300);
    const opened = spread();
    expect(opened.distance / before.distance).toBeGreaterThan(1.8);
    expect(opened.distance / before.distance).toBeLessThan(2.2);
    // A posição dos cartões não é linear na escala (o tamanho muda com o nível de detalhe), então o ancoramento se prova pela
    // inversa: o wheel (que mantém o ponto sob o cursor) no mesmo ponto, com o fator oposto, tem de devolver o mapa onde estava.
    await wheel(mid, 433);
    await settle(500);
    const back = spread();
    expect(Math.abs(back.a.x - before.a.x) + Math.abs(back.a.y - before.a.y)).toBeLessThan(6);
    expect(Math.abs(back.b.x - before.b.x) + Math.abs(back.b.y - before.b.y)).toBeLessThan(6);
    expect(ticketPageOpen()).toBe(false);
  });

  it("pinça fechando reduz na proporção dos dedos e ancora no ponto entre eles", async () => {
    await openMap();
    const before = spread();
    const mid = { x: (before.a.x + before.b.x) / 2, y: (before.a.y + before.b.y) / 2 };
    await wheel(mid, -433);
    await settle(500);
    const zoomed = spread();
    await gesture([{ id: 1, x: mid.x - 80, y: mid.y }, { id: 2, x: mid.x + 80, y: mid.y }], [{ id: 1, x: mid.x - 40, y: mid.y }, { id: 2, x: mid.x + 40, y: mid.y }]);
    await settle(300);
    const after = spread();
    expect(after.distance / zoomed.distance).toBeGreaterThan(0.4);
    expect(after.distance / zoomed.distance).toBeLessThan(0.6);
    expect(Math.abs(after.a.x - before.a.x) + Math.abs(after.a.y - before.a.y)).toBeLessThan(6);
    expect(ticketPageOpen()).toBe(false);
  });

  it("mover os dois dedos juntos desloca o mapa durante a pinça", async () => {
    await openMap();
    const before = spread();
    const mid = { x: (before.a.x + before.b.x) / 2, y: (before.a.y + before.b.y) / 2 };
    await gesture([{ id: 1, x: mid.x - 30, y: mid.y }, { id: 2, x: mid.x + 30, y: mid.y }], [{ id: 1, x: mid.x - 30, y: mid.y + 90 }, { id: 2, x: mid.x + 30, y: mid.y + 90 }]);
    await settle(300);
    const after = spread();
    expect(after.distance / before.distance).toBeCloseTo(1, 1);
    expect(after.a.y - before.a.y).toBeGreaterThan(80);
  });

  it("um dedo arrasta o mapa", async () => {
    await openMap();
    const before = spread();
    const stage = stageRect();
    const from = { id: 1, x: stage.left + stage.width / 2, y: stage.top + stage.height - 120 };
    await gesture([from], [{ id: 1, x: from.x + 70, y: from.y - 60 }]);
    await settle(200);
    const after = spread();
    expect(after.a.x - before.a.x).toBeGreaterThan(55);
    expect(before.a.y - after.a.y).toBeGreaterThan(45);
    expect(after.distance / before.distance).toBeCloseTo(1, 2);
  });

  it("um tap curto sobre um card abre o ticket", async () => {
    await openMap();
    const target = center(card(/ALFA-2 · Publicação/));
    await dispatch("touchStart", [{ id: 1, ...target }]);
    await dispatch("touchEnd", []);
    await settle(300);
    expect(ticketPageOpen()).toBe(true);
  });

  it("arraste de um dedo que termina sobre um card não abre o ticket", async () => {
    await openMap();
    const target = center(card(/ALFA-2 · Publicação/));
    await gesture([{ id: 1, x: target.x - 5, y: target.y - 5 }], [{ id: 1, x: target.x + 40, y: target.y + 20 }]);
    await settle(300);
    expect(ticketPageOpen()).toBe(false);
  });

  it("pinça que termina com os dedos sobre um card não abre o ticket", async () => {
    await openMap();
    const target = center(card(/ALFA-2 · Publicação/));
    await gesture([{ id: 1, x: target.x - 10, y: target.y }, { id: 2, x: target.x + 10, y: target.y }], [{ id: 1, x: target.x - 40, y: target.y }, { id: 2, x: target.x + 40, y: target.y }]);
    await settle(300);
    expect(ticketPageOpen()).toBe(false);
  });

  it("soltar um dedo no meio da pinça segue como arraste, sem salto; um dedo a mais volta a ser pinça", async () => {
    await openMap();
    const mid = center(stageRect());
    const f1 = { id: 1, x: mid.x - 50, y: mid.y };
    const f2 = { id: 2, x: mid.x + 50, y: mid.y };
    await dispatch("touchStart", [f1, f2]);
    await dispatch("touchMove", [{ ...f1, x: f1.x - 20 }, { ...f2, x: f2.x + 20 }]);
    const pinched = spread();
    // Solta só o dedo 2 (touchEnd com o ponto dele): o dedo 1 continua e vira arraste; o mapa não pode saltar no instante da troca.
    await dispatch("touchEnd", [{ ...f2, x: f2.x + 20 }]);
    const afterRelease = spread();
    expect(Math.abs(afterRelease.a.x - pinched.a.x) + Math.abs(afterRelease.a.y - pinched.a.y)).toBeLessThan(2);
    await dispatch("touchMove", [{ ...f1, x: f1.x - 20, y: f1.y + 50 }]);
    const dragged = spread();
    expect(dragged.a.y - afterRelease.a.y).toBeGreaterThan(40);
    expect(dragged.distance / afterRelease.distance).toBeCloseTo(1, 2);
    // Dedo 2 volta: vira pinça sem salto.
    await dispatch("touchStart", [{ ...f1, x: f1.x - 20, y: f1.y + 50 }, { ...f2, x: f2.x + 20, y: f2.y + 50 }]);
    const rejoined = spread();
    expect(Math.abs(rejoined.a.x - dragged.a.x) + Math.abs(rejoined.a.y - dragged.a.y)).toBeLessThan(2);
    expect(rejoined.distance / dragged.distance).toBeCloseTo(1, 2);
    await dispatch("touchEnd", []);
    await settle(300);
    expect(ticketPageOpen()).toBe(false);
  });

  it("a página não rola nem amplia por baixo do mapa durante o gesto", async () => {
    await openMap();
    const mid = center(stageRect());
    const scrollBefore = { x: window.scrollX, y: window.scrollY, scale: window.visualViewport?.scale ?? 1 };
    await gesture([{ id: 1, x: mid.x - 30, y: mid.y }, { id: 2, x: mid.x + 30, y: mid.y }], [{ id: 1, x: mid.x - 90, y: mid.y - 120 }, { id: 2, x: mid.x + 90, y: mid.y - 120 }]);
    await gesture([{ id: 1, x: mid.x, y: mid.y + 100 }], [{ id: 1, x: mid.x, y: mid.y - 150 }]);
    expect({ x: window.scrollX, y: window.scrollY, scale: window.visualViewport?.scale ?? 1 }).toEqual(scrollBefore);
    expect(getComputedStyle(document.querySelector("[aria-label='Mapa da organização']")!).touchAction).toBe("none");
  });
});
