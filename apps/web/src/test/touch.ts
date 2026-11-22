import { cdp } from "vitest/browser";

/** Toque emulado pelo CDP (Input.dispatchTouchEvent), que gera Pointer Events com pointerType "touch" e o clique sintético de um tap. */
export interface Finger { id: number; x: number; y: number }

// Dois quadros: o primeiro aplica o estado do React que o evento agendou, o segundo deixa a geometria dos cartões chegar ao DOM.
export const frame = async () => {
  for (let count = 0; count < 2; count += 1) await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
};

/** Coordenadas do CDP são as da página de cima; o teste roda num iframe, então soma o deslocamento e a escala dele. */
export function toPage(x: number, y: number) {
  const iframe = window.frameElement?.getBoundingClientRect();
  const scale = iframe && window.frameElement ? iframe.width / window.innerWidth : 1;
  return { x: (iframe?.left ?? 0) + x * scale, y: (iframe?.top ?? 0) + y * scale };
}
const asPoints = (fingers: Finger[]) => fingers.map(({ id, x, y }) => ({ id, ...toPage(x, y) }));
export async function dispatch(type: "touchStart" | "touchMove" | "touchEnd", fingers: Finger[]) {
  await cdp().send("Input.dispatchTouchEvent", { type, touchPoints: asPoints(fingers) });
  await frame();
}
/** Dedos que descem, andam em passos e sobem (touchEnd sem pontos solta todos). */
export async function gesture(start: Finger[], end: Finger[], steps = 8, release = true) {
  await dispatch("touchStart", start);
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    await dispatch("touchMove", start.map((f, index) => ({ id: f.id, x: f.x + (end[index]!.x - f.x) * t, y: f.y + (end[index]!.y - f.y) * t })));
  }
  if (release) await dispatch("touchEnd", []);
}
/** Wheel de mouse no ponto dado (coordenadas do iframe): o caminho de zoom que a pinça tem de reproduzir. */
export async function wheel(at: { x: number; y: number }, deltaY: number) {
  const point = toPage(at.x, at.y);
  await cdp().send("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY });
}
