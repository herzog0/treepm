/** Medidas de layout compartilhadas pelas suítes de navegador do layout (TREEPM-231). */
export interface Box { x: number; y: number; w: number; h: number }

const round = (n: number) => Math.round(n * 10) / 10;

/** Retângulo de cada elemento que casa com o seletor (na ordem do documento), chaveado por `seletor#índice`. */
export function measure(selectors: readonly string[]): Record<string, Box> {
  const out: Record<string, Box> = {};
  for (const selector of selectors) {
    document.querySelectorAll<HTMLElement>(selector).forEach((el, index) => {
      const r = el.getBoundingClientRect();
      out[`${selector}#${index}`] = { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
    });
  }
  out["document"] = { x: 0, y: 0, w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight };
  return out;
}

export const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

/** Espera a geometria dos seletores parar de mudar (carga do editor, fontes, listas) antes de medir; sob carga isso demora mais que um tempo fixo. */
export async function measureStable(selectors: readonly string[]): Promise<Record<string, Box>> {
  const { untilStable } = await import("../test/stable.js");
  await document.fonts.ready;
  await untilStable(() => JSON.stringify(measure(selectors)));
  return measure(selectors);
}
