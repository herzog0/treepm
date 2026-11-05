/** Hex sRGB colors supported by the default mixer: #rgb and #rrggbb (opaque). */
export interface IndicatorColor {
  readonly color: string;
  readonly weight?: number;
}

function channels(color: string): readonly number[] {
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(color)) throw new Error(`Unsupported indicator color "${color}"; use #rgb or #rrggbb, or provide mixColors.`);
  const hex = color.length === 4 ? color.slice(1).split("").map((digit) => digit + digit).join("") : color.slice(1);
  return [0, 2, 4].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
}
const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const srgb = (value: number) => value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;

/** Weighted mean in linear-light RGB, encoded back to sRGB. Order independent.
 * Requires positive finite weights and at least one member. Validates even homogeneous input.
 * Equivalent homogeneous colors preserve the first member's original spelling.
 * For named/rgb()/CSS-variable colors, supply a consumer mixer instead.
 */
export function mixIndicatorColors(colors: readonly IndicatorColor[]): string {
  if (!colors.length) throw new Error("At least one indicator color is required");
  const sorted = colors.map(({ color, weight = 1 }) => {
    if (!Number.isFinite(weight) || weight <= 0) throw new Error("Indicator color weights must be positive and finite");
    return { color, weight, rgb: channels(color) };
  }).sort((a, b) => (a.color < b.color ? -1 : a.color > b.color ? 1 : 0) || a.weight - b.weight);
  const first = sorted[0];
  if (!first) throw new Error("At least one indicator color is required");
  if (sorted.every((entry) => entry.rgb.every((value, index) => value === first.rgb[index]))) return colors[0]?.color ?? first.color;
  // Normalize weights first to avoid overflow when valid finite weights are large.
  const maximum = sorted.reduce((maximum, entry) => Math.max(maximum, entry.weight), 0);
  const total = sorted.reduce((sum, entry) => sum + entry.weight / maximum, 0);
  const result = [0, 1, 2].map((index) => {
    const mean = sorted.reduce((sum, entry) => sum + linear(entry.rgb[index] ?? 0) * (entry.weight / maximum / total), 0);
    return Math.round(Math.min(1, Math.max(0, srgb(mean))) * 255).toString(16).padStart(2, "0");
  });
  return `#${result.join("")}`;
}
