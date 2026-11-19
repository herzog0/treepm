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
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
});

export type AppConfig = z.output<typeof schema>;

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
  return result.data;
}
