import { describe, expect, it } from "vitest";
import { pinchCamera, startPinch } from "./spatialPinch.js";
import type { PinchPoints } from "./spatialPinch.js";

const limits = { minScale: 0.1, maxScale: 8 };
const camera = { x: 40, y: -20, scale: 1 };
const pts = (ax: number, ay: number, bx: number, by: number): PinchPoints => [{ x: ax, y: ay }, { x: bx, y: by }];
const worldUnder = (c: { x: number; y: number; scale: number }, x: number, y: number) => ({ x: (x - c.x) / c.scale, y: (y - c.y) / c.scale });

describe("pinça: zoom ancorado no ponto médio", () => {
  it("sem mover os dedos a câmera não muda", () => {
    const start = startPinch(camera, pts(100, 200, 200, 200));
    const next = pinchCamera(start, pts(100, 200, 200, 200), limits);
    expect(next.x).toBeCloseTo(camera.x);
    expect(next.y).toBeCloseTo(camera.y);
    expect(next.scale).toBeCloseTo(1);
  });

  it("abrir os dedos amplia na proporção das distâncias e mantém o ponto médio sob os dedos", () => {
    const start = startPinch(camera, pts(100, 200, 200, 200));
    const before = worldUnder(camera, 150, 200);
    const next = pinchCamera(start, pts(50, 200, 250, 200), limits);
    expect(next.scale).toBeCloseTo(2);
    const after = worldUnder(next, 150, 200);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("fechar os dedos reduz", () => {
    const start = startPinch(camera, pts(50, 200, 250, 200));
    expect(pinchCamera(start, pts(100, 200, 200, 200), limits).scale).toBeCloseTo(0.5);
  });

  it("mover os dois dedos juntos desloca o mapa sem mudar a escala", () => {
    const start = startPinch(camera, pts(100, 200, 200, 200));
    const next = pinchCamera(start, pts(130, 260, 230, 260), limits);
    expect(next.scale).toBeCloseTo(1);
    expect(next.x).toBeCloseTo(camera.x + 30);
    expect(next.y).toBeCloseTo(camera.y + 60);
  });

  it("zoom e deslocamento ao mesmo tempo: o ponto do mundo inicial segue o novo ponto médio", () => {
    const start = startPinch(camera, pts(100, 200, 200, 200));
    const world = worldUnder(camera, 150, 200);
    const next = pinchCamera(start, pts(120, 300, 320, 300), limits);
    const under = worldUnder(next, 220, 300);
    expect(next.scale).toBeCloseTo(2);
    expect(under.x).toBeCloseTo(world.x);
    expect(under.y).toBeCloseTo(world.y);
  });

  it("respeita os limites de escala e continua ancorado quando o limite entra", () => {
    const start = startPinch(camera, pts(100, 200, 200, 200));
    const world = worldUnder(camera, 150, 200);
    const big = pinchCamera(start, pts(-3850, 200, 4150, 200), limits);
    expect(big.scale).toBe(8);
    const small = pinchCamera(start, pts(149, 200, 151, 200), limits);
    expect(small.scale).toBe(0.1);
    for (const c of [big, small]) {
      const under = worldUnder(c, 150, 200);
      expect(under.x).toBeCloseTo(world.x);
      expect(under.y).toBeCloseTo(world.y);
    }
  });

  it("dedos sobrepostos (distância zero) não geram NaN nem Infinity", () => {
    const start = startPinch(camera, pts(100, 200, 100, 200));
    const next = pinchCamera(start, pts(100, 200, 140, 200), limits);
    expect(Number.isFinite(next.scale) && Number.isFinite(next.x) && Number.isFinite(next.y)).toBe(true);
    const back = pinchCamera(startPinch(camera, pts(100, 200, 200, 200)), pts(150, 200, 150, 200), limits);
    expect(Number.isFinite(back.scale)).toBe(true);
    expect(back.scale).toBe(0.1);
  });

  it("recomeçar a pinça a partir da câmera atual (1↔2 dedos) não dá salto", () => {
    const first = startPinch(camera, pts(100, 200, 200, 200));
    const mid = pinchCamera(first, pts(80, 200, 220, 200), limits);
    // Um dedo sai e volta com os dedos em outro lugar: a nova linha de base parte da câmera exibida.
    const second = startPinch(mid, pts(300, 400, 340, 400));
    const same = pinchCamera(second, pts(300, 400, 340, 400), limits);
    expect(same.x).toBeCloseTo(mid.x);
    expect(same.y).toBeCloseTo(mid.y);
    expect(same.scale).toBeCloseTo(mid.scale);
  });
});
