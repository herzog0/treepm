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
  CLERK_JWT_KEY: z.string().min(1).optional(),
  WEB_DIST_DIR: z.string().min(1).optional(),
  /** Chave da Anthropic (conversa e resumos). Opcional: sem as duas chaves, a IA fica desligada (ADR 0029). */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** Chave da TypeSafe (Jev, procura do caminho). Opcional, como a da Anthropic. */
  TYPESAFE_API_KEY: z.string().min(1).optional(),
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
  PORT: z.coerce.number().int().min(1).max(65535).default(4310),
});

export type AppConfig = z.output<typeof schema>;

/** A IA está ligada só com as duas chaves. */
export function assistantEnabled(config: Pick<AppConfig, "ANTHROPIC_API_KEY" | "TYPESAFE_API_KEY">): boolean {
  return Boolean(config.ANTHROPIC_API_KEY && config.TYPESAFE_API_KEY);
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
  const presentGithub = GITHUB_VARIABLES.filter((name) => result.data[name] !== undefined);
  if (presentGithub.length > 0 && presentGithub.length < GITHUB_VARIABLES.length) {
    const missing = GITHUB_VARIABLES.filter((name) => result.data[name] === undefined);
    throw new ConfigError(`Configuração inválida — a ligação com o GitHub exige as cinco variáveis do app; faltam: ${missing.join(", ")}`);
  }
  return result.data;
}
