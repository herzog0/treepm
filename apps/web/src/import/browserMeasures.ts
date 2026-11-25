import { expect } from "vitest";

// Medidas dos testes de navegador da importação: cor e contraste (4,5:1), rolagem horizontal e centro do texto dos botões.
type Rgba = [number, number, number, number];
function parse(color: string): Rgba {
  const rgb = /^rgba?\(([^)]+)\)$/.exec(color);
  if (rgb) {
    const parts = rgb[1]!.split(/[ ,/]+/).filter(Boolean).map(Number);
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
  }
  const srgb = /^color\(srgb ([^)]+)\)$/.exec(color);
  if (srgb) {
    const parts = srgb[1]!.split(/[ /]+/).filter(Boolean).map(Number);
    return [parts[0]! * 255, parts[1]! * 255, parts[2]! * 255, parts[3] ?? 1];
  }
  throw new Error(`cor ilegível: ${color}`);
}
function backgroundOf(element: Element): [number, number, number] {
  const layers: Rgba[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const color = parse(getComputedStyle(node).backgroundColor);
    if (color[3] > 0) layers.push(color);
    if (color[3] === 1) break;
  }
  let base: [number, number, number] = [8, 9, 13];
  for (const layer of layers.reverse()) base = [0, 1, 2].map((i) => layer[i]! * layer[3] + base[i]! * (1 - layer[3])) as [number, number, number];
  return base;
}
const luminance = ([r, g, b]: number[]) => {
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
};
export function contrastOf(element: Element): number {
  const fg = parse(getComputedStyle(element).color);
  const bg = backgroundOf(element);
  const mixed = [0, 1, 2].map((i) => fg[i]! * fg[3] + bg[i]! * (1 - fg[3]));
  const [a, b] = [luminance(mixed), luminance(bg)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export const noHorizontalScroll = () => {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  expect(document.body.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
};
export function expectTextCentered(button: Element, label: string) {
  const range = document.createRange();
  range.selectNodeContents(button);
  const text = range.getBoundingClientRect();
  const box = button.getBoundingClientRect();
  expect(Math.abs(text.left + text.width / 2 - (box.left + box.width / 2)), `${label}: centro horizontal`).toBeLessThan(1);
  expect(Math.abs(text.top + text.height / 2 - (box.top + box.height / 2)), `${label}: centro vertical`).toBeLessThan(1);
}
