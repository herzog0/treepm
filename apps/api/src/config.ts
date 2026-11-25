import { z } from "zod";

/** Token de injeção da configuração validada. */
export const CONFIG = Symbol("CONFIG");

const nonEmpty = z.string().min(1, "obrigatória");

const schema = z.object({
  DATABASE_URL: nonEmpty.regex(/^postgres(ql)?:\/\//, "deve ser uma URL postgresql://"),
  CLERK_SECRET_KEY: nonEmpty,
  CLERK_PUBLISHABLE_KEY: nonEmpty,
  APP_ORIGIN: nonEmpty.transform((value, ctx) => {
    try {
      return new URL(value).origin;
    } catch {
      ctx.addIssue({ code: "custom", message: "deve ser uma URL de origem válida" });
      return z.NEVER;
    }
  }),
  /**
   * Origens extras da web aceitas além de `APP_ORIGIN` (lista separada por vírgula). Só desenvolvimento: em produção não
   * se define. Lida como texto aqui; `loadConfig` valida item a item e entrega `string[]` (ver `parseExtraOrigins`).
   */
  APP_EXTRA_ORIGINS: z.string().optional(),
  CLERK_JWT_KEY: z.string().min(1).optional(),
  WEB_DIST_DIR: z.string().min(1).optional(),
  /** Chave da Anthropic (conversa e resumos). Opcional: sem as duas chaves, a IA fica desligada (ADR 0029). */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** Chave da TypeSafe (Jev, procura do caminho). Opcional, como a da Anthropic. */
  TYPESAFE_API_KEY: z.string().min(1).optional(),
  /** Chave da Voyage AI (vetores da busca por significado, ADR 0053). Opcional e fora de `assistantEnabled`: sem ela o assistente segue configurado e a busca usa só palavras. */
  VOYAGE_API_KEY: z.string().min(1).optional(),
  /**
   * Como a busca de relacionados usa os vetores (ADR 0053): `off` (padrão) = só palavras, sem ler vetores, sincronizar nem
   * chamar o provedor; `rrf` = soma de posições; `interleave` = intercalação (palavras 1, vetor 1, palavras 2…).
   */
  SEMANTIC_TRIAGE: z.enum(["off", "rrf", "interleave"]).default("off"),
  /** O tipo da consulta ao provedor de vetores nas duas rotas: `query` (padrão) ou `document`. */
  SEMANTIC_QUERY_KIND: z.enum(["query", "document"]).default("query"),
  /**
   * Quando a procura do lugar pergunta (ADR 0054): `LOW` e `HIGH` são a faixa em que "cabe em algum ramo" é dúvida
   * (0 ≤ LOW < HIGH ≤ 1) e `CHOICE` é a probabilidade abaixo da qual o ramo escolhido não se destaca. Só decidem QUANDO
   * perguntar; a descida (BELONGS_LOW/HIGH em `placement-search.ts`) não muda.
   */
  PLACEMENT_DOUBT_LOW: z.coerce.number().min(0).max(1).default(0.2),
  PLACEMENT_DOUBT_HIGH: z.coerce.number().min(0).max(1).default(0.8),
  PLACEMENT_DOUBT_CHOICE: z.coerce.number().min(0).max(1).default(0.5),
  /** Identificador numérico do GitHub App. Opcional: sem as cinco variáveis do app, a ligação com o GitHub fica desligada (ADR 0032). */
  GITHUB_APP_ID: z.string().regex(/^\d+$/, "deve ser numérico").optional(),
  GITHUB_APP_SLUG: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, "deve ser o slug do app").optional(),
  GITHUB_APP_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_APP_CLIENT_SECRET: z.string().min(1).optional(),
  /** PEM PKCS#1 (`BEGIN RSA PRIVATE KEY`) de várias linhas; `\n` literais (variável de uma linha) voltam a ser quebras de linha. */
  GITHUB_APP_PRIVATE_KEY: z
    .string()
    // Aceita `\n` literais (variável de uma linha), CRLF e espaços nas pontas.
    .transform((value) => {
      const text = value.includes("\n") ? value : value.replaceAll("\\n", "\n");
      return `${text.replaceAll("\r\n", "\n").trim()}\n`;
    })
    .refine((value) => /^-----BEGIN RSA PRIVATE KEY-----\n[\s\S]+\n-----END RSA PRIVATE KEY-----\s*$/.test(value), "deve ser um PEM PKCS#1 (BEGIN RSA PRIVATE KEY)")
    .optional(),
  /**
   * Chave de cifra das credenciais de terceiros guardadas por pessoa (ADR 0060): base64 de exatamente 32 bytes (AES-256-GCM). Opcional:
   * sem ela a API sobe e a ligação com o Linear fica desligada. Segredo próprio, nunca derivado de outro.
   */
  CREDENTIALS_ENCRYPTION_KEY: z
    .string()
    .refine((value) => /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, "base64").length === 32, "deve ser base64 de exatamente 32 bytes")
    .optional(),
  /**
   * Nome do cabeçalho que leva o IP do cliente (ex.: `Fly-Client-IP`), usado só pelo limite por IP do servidor MCP
   * (ADR 0038). Opcional: sem ele vale o IP da conexão. Só deve ser definido atrás de um proxy que sobrescreve o cabeçalho.
   */
  CLIENT_IP_HEADER: z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "deve ser um nome de cabeçalho HTTP").optional(),
  PORT: z.coerce.number().int().min(1).max(65535).default(4310),
});

export type AppConfig = Omit<z.output<typeof schema>, "APP_EXTRA_ORIGINS"> & {
  /** Origens extras já validadas, sem repetidos e sem `APP_ORIGIN`; ausente quando a variável não foi definida. */
  APP_EXTRA_ORIGINS?: string[];
};

/** No máximo este tanto de origens extras. */
export const MAX_EXTRA_ORIGINS = 5;

/** Uma origem extra (já reduzida à origem) ou o motivo, sem repetir o valor (pode ter credenciais). */
function parseExtraOrigin(raw: string): { origin: string } | { reason: string } {
  if (raw.includes("*")) return { reason: "não pode ter curinga (*)" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { reason: "não é uma URL válida" };
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) {
    return { reason: "deve usar https (http só em localhost ou 127.0.0.1)" };
  }
  if (url.username !== "" || url.password !== "") return { reason: "não pode ter usuário nem senha" };
  if ((url.pathname !== "/" && url.pathname !== "") || raw.includes("?") || raw.includes("#")) {
    return { reason: "deve ser só a origem, sem caminho, consulta nem fragmento" };
  }
  return { origin: url.origin };
}

/** Valida a lista de `APP_EXTRA_ORIGINS`. Repetidos e a origem principal são ignorados sem erro. Devolve problemas sem valores. */
function parseExtraOrigins(raw: string, primary: string): { origins: string[] } | { problems: string[] } {
  const items = raw.split(",").map((item) => item.trim()).filter((item) => item !== "");
  const problems: string[] = [];
  const origins: string[] = [];
  items.forEach((item, index) => {
    const parsed = parseExtraOrigin(item);
    if ("reason" in parsed) {
      problems.push(`APP_EXTRA_ORIGINS: item ${index + 1} ${parsed.reason}`);
    } else if (parsed.origin !== primary && !origins.includes(parsed.origin)) {
      origins.push(parsed.origin);
    }
  });
  if (problems.length === 0 && origins.length > MAX_EXTRA_ORIGINS) problems.push(`APP_EXTRA_ORIGINS: no máximo ${MAX_EXTRA_ORIGINS} itens`);
  return problems.length > 0 ? { problems } : { origins };
}

/** Todas as origens da web que a API aceita (sessão do Clerk e `Origin` do MCP): a principal primeiro, depois as extras. */
export function allowedOrigins(config: Pick<AppConfig, "APP_ORIGIN" | "APP_EXTRA_ORIGINS">): string[] {
  return [config.APP_ORIGIN, ...(config.APP_EXTRA_ORIGINS ?? [])];
}

/** A IA está ligada só com as duas chaves. */
export function assistantEnabled(config: Pick<AppConfig, "ANTHROPIC_API_KEY" | "TYPESAFE_API_KEY">): boolean {
  return Boolean(config.ANTHROPIC_API_KEY && config.TYPESAFE_API_KEY);
}

/** A ligação com o Linear (ADR 0060) está ligada só com a chave de cifra das credenciais. */
export function linearEnabled(config: Pick<AppConfig, "CREDENTIALS_ENCRYPTION_KEY">): boolean {
  return Boolean(config.CREDENTIALS_ENCRYPTION_KEY);
}

export const GITHUB_VARIABLES = [
  "GITHUB_APP_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_CLIENT_SECRET",
  "GITHUB_APP_PRIVATE_KEY",
] as const;

/** A ligação com o GitHub está ligada só com as cinco variáveis do app (`loadConfig` recusa de uma a quatro). */
export function githubEnabled(config: Partial<Pick<AppConfig, (typeof GITHUB_VARIABLES)[number]>>): boolean {
  return GITHUB_VARIABLES.every((name) => Boolean(config[name]));
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Valida o ambiente na inicialização. Só as variáveis do esquema são lidas:
 * a URL de migração (papel dono) nunca entra na configuração da API (ADR 0021).
 * A mensagem de erro cita nomes de variáveis, nunca valores.
 */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const picked: Record<string, string | undefined> = {};
  for (const key of Object.keys(schema.shape)) {
    const value = env[key];
    picked[key] = value === "" ? undefined : value;
  }
  const result = schema.safeParse(picked);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new ConfigError(`Configuração inválida — ${problems.join("; ")}`);
  }
  const { APP_EXTRA_ORIGINS: rawExtras, ...rest } = result.data;
  const config: AppConfig = rest;
  if (rawExtras !== undefined) {
    const extras = parseExtraOrigins(rawExtras, config.APP_ORIGIN);
    if ("problems" in extras) throw new ConfigError(`Configuração inválida — ${extras.problems.join("; ")}`);
    config.APP_EXTRA_ORIGINS = extras.origins;
  }
  if (!(config.PLACEMENT_DOUBT_LOW < config.PLACEMENT_DOUBT_HIGH)) {
    throw new ConfigError("Configuração inválida — PLACEMENT_DOUBT_LOW: deve ser menor que PLACEMENT_DOUBT_HIGH");
  }
  const presentGithub = GITHUB_VARIABLES.filter((name) => config[name] !== undefined);
  if (presentGithub.length > 0 && presentGithub.length < GITHUB_VARIABLES.length) {
    const missing = GITHUB_VARIABLES.filter((name) => config[name] === undefined);
    throw new ConfigError(`Configuração inválida — a ligação com o GitHub exige as cinco variáveis do app; faltam: ${missing.join(", ")}`);
  }
  return config;
}
