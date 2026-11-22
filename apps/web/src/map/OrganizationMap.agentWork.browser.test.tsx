import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { cdp, page } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import "../assistant/assistant.css";
import "./map.css";
import "./agent-work.css";
import "@treepm/react/styles.css";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

// ADR 0043: o contorno tracejado animado do ticket em trabalho pela IA, desenhado de verdade (CSS, tamanhos, movimento).
const project = makeProject("p1", "ALFA", "Projeto Alfa");
const CAPTURES = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES"];
const settle = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms));
const shot = async (name: string) => {
  if (CAPTURES) await page.screenshot({ path: `${CAPTURES}/${name}.png` });
};

function Harness({ working = true, openId: initial = null }: { working?: boolean; openId?: string | null }) {
  const [openId, setOpenId] = useState<string | null>(initial);
  const [client] = useState(() => {
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    return makeTreeClient({
      projects: [project],
      tickets: {
        p1: [
          makeTicket("t1", "p1", 1, "Escrever os testes", { key: "ALFA-1", status: "in_progress", ...(working ? { agentWork: { since, until, note: "escrevendo os testes" } } : {}) }),
          makeTicket("t2", "p1", 2, "Publicação", { key: "ALFA-2" }),
          makeTicket("t3", "p1", 3, "Revisar o texto", { key: "ALFA-3", status: "in_review" }),
        ],
      },
      people: [makePerson("person-1", "Ana")],
    });
  });
  return (
    <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
      <OrganizationMap client={client} me={makePanelMe("admin")} openTicketId={openId} onOpenTicketChange={setOpenId} />
    </main>
  );
}
const article = (id: string) => document.querySelector<HTMLElement>(`.spatial-node[data-spatial-id="${id}"]`);
const visual = (id: string) => article(id)?.querySelector<HTMLElement>(".spatial-card-visual") ?? null;

async function explore(screen: Awaited<ReturnType<typeof render>>) {
  await screen.getByRole("button", { name: /ALFA · Projeto Alfa/ }).click();
  await screen.getByRole("button", { name: "Explorar ramo" }).click();
  await settle();
}
async function reducedMotion(value: "reduce" | "no-preference") {
  await cdp().send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value }] });
}

afterEach(async () => {
  await reducedMotion("no-preference");
});

describe("contorno do ticket em trabalho pela IA, em navegador real", () => {
  it("anda em volta do card: 2 px, tracejado de 6 px e vão de 4 px, uma volta de 10 px a cada 0,6 s", async () => {
    await page.viewport(1440, 900);
    const screen = await render(<Harness />);
    await explore(screen);
    const path = visual("t1")!.querySelector<SVGRectElement>(".agent-work-ring rect")!;
    const ring = getComputedStyle(path);
    expect(getComputedStyle(visual("t1")!, "::after").animationName).toBe("none");
    expect(ring.animationName).toBe("agent-work-march");
    expect(ring.animationDuration).toBe("0.6s");
    expect(ring.animationIterationCount).toBe("infinite");
    expect(ring.animationTimingFunction).toBe("linear");
    expect(ring.strokeWidth).toBe("2px");
    expect(ring.strokeDasharray.replace(/\s/g, "")).toBe("6px,4px");
    expect(getComputedStyle(path.ownerSVGElement!).pointerEvents).toBe("none");
    expect(getComputedStyle(visual("t1")!).getPropertyValue("--aw-dash").trim()).toBe("6px");
    // O traço anda de verdade: o deslocamento do tracejado muda com o tempo.
    const before = getComputedStyle(path).strokeDashoffset;
    await settle(150);
    expect(getComputedStyle(path).strokeDashoffset).not.toBe(before);
    await shot("mapa-completo-em-trabalho");
  });

  it("só o ticket em trabalho tem contorno: nem os comuns nem o pai", async () => {
    await page.viewport(1440, 900);
    const screen = await render(<Harness />);
    await explore(screen);
    expect(getComputedStyle(visual("t2")!, "::after").animationName).toBe("none");
    expect(getComputedStyle(visual("t3")!, "::after").animationName).toBe("none");
    expect(getComputedStyle(visual("p1")!, "::after").animationName).toBe("none");
    expect(document.querySelectorAll(".agent-work-ring")).toHaveLength(1);
    expect(visual("t1")!.querySelector(".agent-work-ring")).not.toBeNull();
  });

  it("não muda o tamanho nem desloca nada em volta", async () => {
    await page.viewport(1440, 900);
    const rects = async (working: boolean) => {
      const screen = await render(<Harness working={working} />);
      await explore(screen);
      const read = Object.fromEntries(["t1", "t2", "t3"].map((id) => {
        const box = visual(id)!.getBoundingClientRect();
        return [id, [box.left, box.top, box.width, box.height].map(Math.round)];
      }));
      await screen.unmount();
      return read;
    };
    expect(await rects(true)).toEqual(await rects(false));
  });

  it("com movimento reduzido o tracejado fica parado", async () => {
    await page.viewport(1440, 900);
    await reducedMotion("reduce");
    const screen = await render(<Harness />);
    await explore(screen);
    const path = visual("t1")!.querySelector<SVGRectElement>(".agent-work-ring rect")!;
    expect(getComputedStyle(path).animationName).toBe("none");
    const before = getComputedStyle(path).strokeDashoffset;
    await settle(200);
    expect(getComputedStyle(path).strokeDashoffset).toBe(before);
  });

  it("aparece em todo nível de detalhe: o ponto pulsa, os cards andam", async () => {
    await page.viewport(1440, 900);
    const screen = await render(<Harness />);
    await explore(screen);
    const seen = new Map<string, { name: string; duration: string }>();
    const note = () => {
      const lod = article("t1")?.getAttribute("data-lod");
      if (lod) {
        // No ponto o halo é o ::after; nos outros níveis o contorno é o retângulo do <svg>.
        const style = lod === "dot" ? getComputedStyle(visual("t1")!, "::after") : getComputedStyle(visual("t1")!.querySelector(".agent-work-ring rect")!);
        seen.set(lod, { name: style.animationName, duration: style.animationDuration });
      }
    };
    note();
    for (let step = 0; step < 14; step += 1) {
      await screen.getByRole("button", { name: "Reduzir zoom" }).click();
      await settle(500);
      note();
      const lod = article("t1")?.getAttribute("data-lod");
      if (lod) await shot(`mapa-nivel-${lod}`);
    }
    expect([...seen.keys()]).toEqual(expect.arrayContaining(["dot", "compact"]));
    for (const [lod, value] of seen) {
      if (lod === "dot") expect(value).toEqual({ name: "agent-work-pulse", duration: "2.4s" });
      else expect(value).toEqual({ name: "agent-work-march", duration: "0.6s" });
    }
  });

  it("é diferente do card tracejado do rascunho: aquele é fino, parado e sólido por fora", async () => {
    await page.viewport(1440, 900);
    const screen = await render(<Harness />);
    await explore(screen);
    const rule = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules]).find((entry) => entry.cssText.includes(".node-draft") && entry.cssText.includes("dashed"));
    expect(rule?.cssText).toContain("1px dashed");
    expect(rule?.cssText).not.toContain("animation");
    expect(getComputedStyle(visual("t1")!.querySelector(".agent-work-ring rect")!).animationName).toBe("agent-work-march");
  });
});

/** Um card montado à mão, com as classes e a estrutura que o pacote do mapa gera, para ver cada nível de detalhe lado a lado. */
function Card({ id, lod, width, height, left, top, color, working = false, draft = false, selected = false, children }: { id: string; lod: string; width: number; height: number; left: number; top: number; color: string; working?: boolean; draft?: boolean; selected?: boolean; children?: React.ReactNode }) {
  return (
    <article
      className={`spatial-node spatial-lod-${lod} ${selected ? "is-selected" : ""}`}
      data-spatial-id={id}
      data-lod={lod}
      style={{ left, top, width, height, ["--spatial-color" as string]: color, ["--spatial-reveal" as string]: 1 } as React.CSSProperties}
    >
      <div className="spatial-card-visual" style={{ ["--spatial-reveal" as string]: 1 } as React.CSSProperties}>
        {working && <svg className="agent-work-ring" aria-hidden="true" focusable="false"><rect /></svg>}
        <button type="button" className="spatial-card-button" style={{ ["--spatial-reveal" as string]: 1 } as React.CSSProperties}>
          <span className="spatial-lod-content">
            {working && <span className="node-agent-work">Em trabalho pela IA</span>}
            {draft ? <span className="node-draft"><strong>Rascunho</strong></span> : children}
          </span>
        </button>
      </div>
    </article>
  );
}

function Gallery() {
  const blue = "#6ea8ff";
  const grey = "#8b92a3";
  const accent = "#a99bff";
  return (
    <div className="org-map spatial-shell is-color-mode" data-spatial-canvas style={{ position: "fixed", inset: 0, background: "var(--tp-bg)" }}>
      <Card id="full-w" lod="full" left={40} top={40} width={190} height={96} color={blue} working><span className="spatial-key">ALFA-1</span><strong>Escrever os testes</strong></Card>
      <Card id="full-n" lod="full" left={270} top={40} width={190} height={96} color={grey}><span className="spatial-key">ALFA-2</span><strong>Publicação</strong></Card>
      <Card id="full-d" lod="full" left={500} top={40} width={190} height={96} color={accent} draft />
      <Card id="full-s" lod="full" left={730} top={40} width={190} height={96} color={blue} working selected><span className="spatial-key">ALFA-4</span><strong>Selecionado e em trabalho</strong></Card>
      <Card id="compact-w" lod="compact" left={40} top={200} width={110} height={52} color={blue} working><span className="spatial-key">ALFA-1</span><strong>Escrever</strong></Card>
      <Card id="compact-n" lod="compact" left={190} top={200} width={110} height={52} color={grey}><span className="spatial-key">ALFA-2</span><strong>Publicação</strong></Card>
      <Card id="chip-w" lod="chip" left={340} top={210} width={86} height={22} color={blue} working><strong>Escrever</strong></Card>
      <Card id="chip-n" lod="chip" left={470} top={210} width={86} height={22} color={grey}><strong>Publicação</strong></Card>
      <Card id="dot-w" lod="dot" left={620} top={214} width={12} height={12} color={blue} working />
      <Card id="dot-n" lod="dot" left={670} top={214} width={12} height={12} color={grey} />
    </div>
  );
}

describe("o contorno em cada nível de detalhe, com a estrutura do pacote", () => {
  it("cards andam (completo, compacto, chip) e o ponto pulsa; os comuns e o rascunho não têm contorno animado", async () => {
    await page.viewport(1000, 340);
    await render(<Gallery />);
    await settle(100);
    const ring = (id: string) => getComputedStyle(visual(id)!, "::after");
    const march = (id: string) => getComputedStyle(visual(id)!.querySelector(".agent-work-ring rect")!);
    for (const id of ["full-w", "full-s", "compact-w", "chip-w"]) {
      expect(march(id).animationName, id).toBe("agent-work-march");
      expect(march(id).animationDuration, id).toBe("0.6s");
    }
    expect(ring("dot-w").animationName).toBe("agent-work-pulse");
    expect(ring("dot-w").animationDuration).toBe("2.4s");
    for (const id of ["full-n", "full-d", "compact-n", "chip-n", "dot-n"]) expect(ring(id).animationName, id).toBe("none");
    // O rascunho segue como estava: borda tracejada fina de 1 px, sem movimento.
    expect(getComputedStyle(visual("full-d")!).borderTopStyle).toBe("dashed");
    expect(getComputedStyle(visual("full-d")!).animationName).toBe("none");
    await shot("niveis-lado-a-lado");
  });

  it("no ponto o traço é fino (2 px) e o halo fica fora do quadrado; com movimento reduzido não pulsa", async () => {
    await page.viewport(1000, 340);
    await render(<Gallery />);
    const dot = getComputedStyle(visual("dot-w")!, "::after");
    expect(dot.borderTopWidth).toBe("2px");
    expect(dot.backgroundImage).toBe("none");
    await reducedMotion("reduce");
    await settle(100);
    expect(getComputedStyle(visual("dot-w")!, "::after").animationName).toBe("none");
    expect(getComputedStyle(visual("chip-w")!.querySelector(".agent-work-ring rect")!).animationName).toBe("none");
  });
});

describe("o contorno acompanha os cantos arredondados do card (TREEPM-199)", () => {
  const ringPath = (id: string) => visual(id)!.querySelector<SVGRectElement>(".agent-work-ring rect");
  const radius = (el: Element) => parseFloat(getComputedStyle(el).borderTopLeftRadius);

  it("em cada nível de detalhe com card, o raio do contorno é o do card mais o afastamento (4 px até o meio do traço, 5 px até a borda de fora)", async () => {
    await page.viewport(1000, 340);
    await render(<Gallery />);
    await settle(100);
    for (const id of ["full-w", "full-s", "compact-w", "chip-w"]) {
      const path = ringPath(id);
      expect(path, id).not.toBeNull();
      const cardRadius = radius(visual(id)!);
      expect(cardRadius, id).toBeGreaterThan(1);
      const rx = parseFloat(getComputedStyle(path!).rx);
      expect(rx, id).toBeCloseTo(cardRadius + 4, 1);
      expect(getComputedStyle(path!).strokeWidth, id).toBe("2px");
      // O traço fica do lado de fora do card: o retângulo do contorno é maior que o do card em 5 px de cada lado (4 px do meio do traço + 1 px de meia espessura).
      const outer = ringPath(id)!.ownerSVGElement!.getBoundingClientRect();
      const card = visual(id)!.getBoundingClientRect();
      expect(card.left - outer.left, id).toBeCloseTo(5, 0);
      expect(outer.right - card.right, id).toBeCloseTo(5, 0);
      expect(card.top - outer.top, id).toBeCloseTo(5, 0);
      expect(outer.bottom - card.bottom, id).toBeCloseTo(5, 0);
    }
    expect(ringPath("full-n")).toBeNull();
    expect(ringPath("dot-w") === null || getComputedStyle(ringPath("dot-w")!.ownerSVGElement!).display === "none").toBe(true);
  });

  it("os cantos são redondos de verdade: o comprimento do caminho é o de um retângulo com cantos de quarto de círculo", async () => {
    await page.viewport(1000, 340);
    await render(<Gallery />);
    await settle(100);
    for (const id of ["full-w", "compact-w", "chip-w"]) {
      const path = ringPath(id)!;
      const rx = parseFloat(getComputedStyle(path).rx);
      const { width, height } = path.getBBox();
      expect(rx, id).toBeGreaterThan(3);
      // Retângulo reto: 2(w+h). Com cantos de raio r: 2(w+h) - 8r + 2πr.
      const rounded = 2 * (width + height) - 8 * rx + 2 * Math.PI * rx;
      expect(path.getTotalLength(), id).toBeCloseTo(rounded, -1);
      expect(path.getTotalLength(), id).toBeLessThan(2 * (width + height) - 1);
    }
  });

  it("segue na mesma cor do nó, o mesmo sentido (horário) e o mesmo passo: 6 px de traço, 4 px de vão, 10 px a cada 0,6 s", async () => {
    await page.viewport(1000, 340);
    await render(<Gallery />);
    await settle(100);
    const path = ringPath("full-w")!;
    const style = getComputedStyle(path);
    expect(style.stroke).toBe("rgb(110, 168, 255)");
    expect(style.strokeDasharray.replace(/\s/g, "")).toBe("6px,4px");
    expect(style.animationName).toBe("agent-work-march");
    expect(style.animationDuration).toBe("0.6s");
    expect(style.animationTimingFunction).toBe("linear");
    expect(style.animationIterationCount).toBe("infinite");
    // Horário: o deslocamento do tracejado diminui (o desenho do retângulo parte do canto de cima e segue para a direita).
    const first = parseFloat(getComputedStyle(path).strokeDashoffset);
    await settle(150);
    const second = parseFloat(getComputedStyle(path).strokeDashoffset);
    expect(second).not.toBe(first);
    expect(second < first || second > first + 5).toBe(true);
    await reducedMotion("reduce");
    await settle(100);
    expect(getComputedStyle(path).animationName).toBe("none");
  });
});

describe("a página do ticket com o marcador, em navegador real", () => {
  it("mostra a linha 'Em trabalho pela IA' junto das propriedades", async () => {
    await page.viewport(1440, 900);
    const screen = await render(<Harness openId="t1" />);
    await settle(900);
    await expect.element(screen.getByText("Em trabalho pela IA", { exact: true }).first()).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Encerrar" })).toBeVisible();
    await expect.element(screen.getByText("escrevendo os testes")).toBeVisible();
    await shot("pagina-do-ticket-em-trabalho");
  });
});
