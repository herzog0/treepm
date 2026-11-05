export const DEFAULT_SPATIAL_SCENE_OPTIONS = Object.freeze({
  fullWidth: 130, compactWidth: 65, chipWidth: 28,
  rootRevealWidth: 100, childRevealWidth: 260, deeperRevealWidth: 180, readableChildWidth: 110,
  revealStart: 0.85, revealRange: 0.3,
  translationXStart: 0.12, translationXRange: 0.63, translationYRange: 0.45,
  growthStart: 0.25, growthRange: 0.75, splitStart: 0.25, splitRange: 0.5,
  previewStart: 0.7, previewRange: 0.3, previewMinWidth: 4, previewWidthRange: 8,
  contentMinWidth: 24, contentWidthRange: 60,
  maxSlots: 8, indicatorSize: 6, indicatorGap: 3, indicatorOffsetY: 5,
  cullingMargin: 100,
});

export type SpatialSceneOptions = { readonly [Key in keyof typeof DEFAULT_SPATIAL_SCENE_OPTIONS]?: number };
export type SceneConfig = { readonly [Key in keyof typeof DEFAULT_SPATIAL_SCENE_OPTIONS]: number };

const KEYS = [
  "fullWidth", "compactWidth", "chipWidth", "rootRevealWidth", "childRevealWidth", "deeperRevealWidth", "readableChildWidth",
  "revealStart", "revealRange", "translationXStart", "translationXRange", "translationYRange", "growthStart", "growthRange",
  "splitStart", "splitRange", "previewStart", "previewRange", "previewMinWidth", "previewWidthRange", "contentMinWidth",
  "contentWidthRange", "maxSlots", "indicatorSize", "indicatorGap", "indicatorOffsetY", "cullingMargin",
] as const;

const DEFAULT_KEY = KEYS.map((key) => DEFAULT_SPATIAL_SCENE_OPTIONS[key]).join(",");

export function normalizeSceneOptions(options?: SpatialSceneOptions): SceneConfig {
  if (!options || options === DEFAULT_SPATIAL_SCENE_OPTIONS) return DEFAULT_SPATIAL_SCENE_OPTIONS;
  const config: { -readonly [Key in keyof SceneConfig]: number } = { ...DEFAULT_SPATIAL_SCENE_OPTIONS };
  let changed = false;
  for (const key of KEYS) {
    const value = options[key];
    if (value === undefined || value === DEFAULT_SPATIAL_SCENE_OPTIONS[key]) continue;
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${key} must be finite and nonnegative`);
    if ((key.endsWith("Range") || key.endsWith("Width") && !key.endsWith("MinWidth") || key === "indicatorSize" || key === "maxSlots") && value <= 0) {
      throw new RangeError(`${key} must be positive`);
    }
    config[key] = value;
    changed = true;
  }
  if (!changed) return DEFAULT_SPATIAL_SCENE_OPTIONS;
  if (!Number.isSafeInteger(config.maxSlots)) throw new RangeError("maxSlots must be a positive safe integer");
  if (config.fullWidth < config.compactWidth || config.compactWidth < config.chipWidth) throw new RangeError("LOD widths must be descending: full >= compact >= chip");
  for (const [start, range] of [[config.translationXStart, config.translationXRange], [0, config.translationYRange], [config.growthStart, config.growthRange], [config.splitStart, config.splitRange], [config.previewStart, config.previewRange]] as const) {
    if (start + range > 1) throw new RangeError("Morph intervals must complete within reveal [0, 1]");
  }
  return config;
}

/** Canonical by value, including fresh default objects supplied on every render. */
export function sceneOptionsKey(config: SceneConfig): string {
  return config === DEFAULT_SPATIAL_SCENE_OPTIONS ? DEFAULT_KEY : KEYS.map((key) => config[key]).join(",");
}
