/**
 * Etiquetas por projeto (ADR 0065): nome livre de até 60 caracteres, único no projeto sem diferenciar maiúsculas, e uma cor de uma
 * paleta fixa de oito. Funções puras, usadas igual pela tela, pela API, pelo MCP e pela sincronização com o Linear: o nome que um
 * lado aceita é o que o banco grava.
 */

/** Teto do nome, em pontos de código (o `char_length` do Postgres): um emoji conta 1, como no banco. */
export const LABEL_NAME_MAX = 60;
/** Etiquetas por ticket e por projeto (ADR 0065, seção 1): o seletor e o filtro continuam usáveis. Valem no domínio e na API, não no banco. */
export const LABELS_PER_TICKET = 20;
export const LABELS_PER_PROJECT = 200;

/**
 * A paleta (ADR 0065, seção 2): oito chaves, escolhidas para não se confundir com as cinco cores de situação do mapa (ADR 0051) nem
 * com a cor de ideia e o destaque: todas a pelo menos 20 de distância perceptual (ΔE76) de cada uma delas. Sem vermelho, verde, azul,
 * amarelo nem cinza-azulado (a cor de "a fazer"): o cinza daqui é quente.
 */
export const LABEL_COLORS = ["gray", "brown", "orange", "olive", "cyan", "indigo", "violet", "rose"] as const;
export type LabelColor = (typeof LABEL_COLORS)[number];

/**
 * O valor de referência de cada chave (o do tema escuro, `--tp-label-<chave>` em `apps/web/src/theme.css`). Só serve para converter a cor
 * do Linear; a tela usa os tokens.
 */
export const LABEL_HEX: Readonly<Record<LabelColor, string>> = {
  gray: "#b8b0a6",
  brown: "#c49064",
  orange: "#ff9a3c",
  olive: "#b0cf3a",
  cyan: "#36cfe6",
  indigo: "#6366f1",
  violet: "#d68bff",
  rose: "#ff8fb8",
};

export function isLabelColor(value: unknown): value is LabelColor {
  return typeof value === "string" && (LABEL_COLORS as readonly string[]).includes(value);
}

/** Teto da chave (`project_labels_name_key_check`): a NFKC expande (um "\ufdfa" vira 18 pontos de código), e o nome cuja chave passa disto é inválido. */
export const LABEL_NAME_KEY_MAX = 240;

/** Controle (C0, DEL, C1) e separadores de linha e parágrafo: viram espaço. */
// eslint-disable-next-line no-control-regex -- é justamente o que se quer tirar
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
/**
 * Formato invisível (zero-width, junção de palavra, BOM, hífen suave) e controles de direção: saem sem deixar espaço, para "bug", "bug\u200b" e
 * "b\u00adug" serem a mesma etiqueta. Os mesmos que o CHECK `project_labels_name_check` recusa.
 */
const INVISIBLE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;
const INVISIBLE_ALL = new RegExp(INVISIBLE.source, "g");
const SPACE = /\s/;
/** O que o CHECK do nome recusa em qualquer posição: controle, separadores e invisíveis. */
// eslint-disable-next-line no-control-regex -- é justamente o que se quer recusar
const REFUSED_CHAR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u00ad\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/;

/**
 * O banco recusaria este nome guardado como está (os CHECKs `project_labels_name_check` e `project_labels_name_key_check` da migration
 * 0048, com a chave `labelNameKey(name)`): de 1 a 60 pontos de código, sem espaço nas pontas, sem controle nem invisível, e a chave de 1 a
 * 240. Conferida contra o banco de verdade pela lista `LABEL_NAME_CASES`.
 */
export function labelNameRefused(name: string): boolean {
  if (typeof name !== "string") return true;
  const length = [...name].length;
  if (length < 1 || length > LABEL_NAME_MAX) return true;
  if (name.startsWith(" ") || name.endsWith(" ") || REFUSED_CHAR.test(name)) return true;
  const keyLength = [...labelNameKey(name)].length;
  return keyLength < 1 || keyLength > LABEL_NAME_KEY_MAX;
}

/**
 * O nome como é guardado, ou `null` quando é inválido. Controle, quebra de linha e caractere nulo viram espaço; invisíveis saem; espaços
 * seguidos viram um; as pontas são aparadas; o resultado é normalizado (NFC) e cortado em `LABEL_NAME_MAX` pontos de código, sem partir um
 * emoji e sem espaço no fim. Inválido: não sobra nada, ou a chave passa do teto do banco (`labelNameRefused`). Lê no máximo o que precisa:
 * um texto de 100 mil caracteres custa o mesmo que o começo dele (tempo linear, sem regex sobre o texto inteiro).
 */
export function cleanLabelName(raw: string): string | null {
  if (typeof raw !== "string") return null;
  let out = "";
  let count = 0;
  let pendingSpace = false;
  // Folga sobre o teto: a normalização NFC pode juntar dois pontos de código num só.
  const budget = LABEL_NAME_MAX * 2;
  for (const char of raw) {
    if (INVISIBLE.test(char)) continue;
    if (CONTROL.test(char) || SPACE.test(char)) {
      pendingSpace = count > 0;
      continue;
    }
    if (pendingSpace) {
      out += " ";
      count += 1;
      pendingSpace = false;
    }
    out += char;
    count += 1;
    if (count >= budget) break;
  }
  const normalized = [...out.normalize("NFC")].slice(0, LABEL_NAME_MAX).join("").trimEnd();
  return normalized === "" || labelNameRefused(normalized) ? null : normalized;
}

/**
 * A chave de unicidade do nome (`project_labels.name_key`): compatibilidade (NFKC: largura total, ligaduras) e minúsculas sem localidade.
 * Preenchida pelo domínio, não pelo `lower()` do banco: o resultado não depende da localidade de cada banco (o de teste e o de produção
 * podem diferir) e é o mesmo que a tela usa para decidir se oferece "Criar «texto»". Ignora os invisíveis (a tela compara o texto cru).
 */
export function labelNameKey(name: string): string {
  return name.replace(INVISIBLE_ALL, "").normalize("NFKC").toLowerCase().normalize("NFKC").replace(INVISIBLE_ALL, "");
}

export function sameLabelName(a: string, b: string): boolean {
  return labelNameKey(a) === labelNameKey(b);
}

/** "Grupo: Nome" (duas etiquetas do Linear de grupos diferentes com o mesmo nome; ADR 0065, seção 5), limpo e cortado em 60. */
export function groupedLabelName(group: string, name: string): string | null {
  const cleanGroup = cleanLabelName(group);
  return cleanLabelName(cleanGroup === null ? name : `${cleanGroup}: ${name}`);
}

function hexToRgb(value: unknown): [number, number, number] | null {
  if (typeof value !== "string") return null;
  const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value);
  if (!match) return null;
  const digits = (match[1] as string).length === 3 ? [...(match[1] as string)].map((c) => c + c).join("") : (match[1] as string);
  const n = Number.parseInt(digits, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** CIE Lab (D65), para a distância perceptual simples (ΔE76). */
function lab([r, g, b]: [number, number, number]): [number, number, number] {
  const linear = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const x = (lr * 0.4124 + lg * 0.3576 + lb * 0.1805) / 0.95047;
  const y = lr * 0.2126 + lg * 0.7152 + lb * 0.0722;
  const z = (lr * 0.0193 + lg * 0.1192 + lb * 0.9505) / 1.08883;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

const PALETTE_LAB: readonly (readonly [LabelColor, [number, number, number]])[] = LABEL_COLORS.map((color) => [color, lab(hexToRgb(LABEL_HEX[color]) as [number, number, number])] as const);

/** A chave da paleta mais próxima de uma cor hexadecimal (a do Linear); hexadecimal inválido vira `gray`. */
export function nearestLabelColor(hex: string): LabelColor {
  const rgb = hexToRgb(hex);
  if (rgb === null) return "gray";
  const [l, a, b] = lab(rgb);
  let best: LabelColor = "gray";
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [color, [pl, pa, pb]] of PALETTE_LAB) {
    const distance = (l - pl) ** 2 + (a - pa) ** 2 + (b - pb) ** 2;
    if (distance < bestDistance) [best, bestDistance] = [color, distance];
  }
  return best;
}

/**
 * A cor de uma etiqueta criada digitando o nome (seletor, API, MCP): determinística pelo nome (FNV-1a da chave), para o mesmo nome ter
 * a mesma cor em qualquer projeto, sem consulta. Quem administra troca depois.
 */
export function defaultLabelColor(name: string): LabelColor {
  let hash = 0x811c9dc5;
  for (const char of labelNameKey(name)) {
    hash ^= char.codePointAt(0) as number;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return LABEL_COLORS[hash % LABEL_COLORS.length] as LabelColor;
}
