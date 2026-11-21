/**
 * Conferência do adaptador real do GitHub (ADR 0032). Quem roda é a coordenação:
 *
 *   pnpm --filter @treepm/api github:check
 *
 * Lê as cinco variáveis `GITHUB_APP_*` (do ambiente ou de `apps/api/.env.local`), autentica como o app pelo adaptador
 * real, chama `GET /app` e `GET /app/installations` e imprime SÓ o slug do app, o nome das permissões e a quantidade de
 * instalações. Nenhum token, chave, identificador de instalação ou login sai. Com o GitHub desligado, diz isso e sai
 * com código diferente de zero, sem chamar nada.
 */
import { GITHUB_VARIABLES, githubEnabled, loadConfig } from "../src/config.js";
import { disabledMessage, formatCheckReport } from "../src/github/check-report.js";
import { OctokitRepositoryProvider } from "../src/github/octokit-repository-provider.js";

const env = process.env;
const missing = GITHUB_VARIABLES.filter((name) => !env[name]);
if (missing.length > 0) {
  console.error(disabledMessage(missing));
  process.exit(2);
}

// As variáveis passam pela mesma validação da API; os campos fictícios abaixo só satisfazem o restante do esquema.
let config;
try {
  config = loadConfig({
    DATABASE_URL: "postgresql://nao-usado/nao-usado",
    CLERK_SECRET_KEY: "nao-usado",
    CLERK_PUBLISHABLE_KEY: "nao-usado",
    APP_ORIGIN: "http://localhost",
    ...Object.fromEntries(GITHUB_VARIABLES.map((name) => [name, env[name]])),
  });
} catch (error) {
  console.error(error instanceof Error ? error.message : "Configuração inválida.");
  process.exit(2);
}
if (!githubEnabled(config) || !config.GITHUB_APP_ID || !config.GITHUB_APP_SLUG || !config.GITHUB_APP_CLIENT_ID || !config.GITHUB_APP_CLIENT_SECRET || !config.GITHUB_APP_PRIVATE_KEY) {
  console.error(disabledMessage(GITHUB_VARIABLES));
  process.exit(2);
}

try {
  const provider = new OctokitRepositoryProvider({
    appId: config.GITHUB_APP_ID,
    slug: config.GITHUB_APP_SLUG,
    clientId: config.GITHUB_APP_CLIENT_ID,
    clientSecret: config.GITHUB_APP_CLIENT_SECRET,
    privateKey: config.GITHUB_APP_PRIVATE_KEY,
  });
  console.log(formatCheckReport(await provider.describeApp()));
} catch {
  // Nada do erro é impresso: ele pode carregar corpo de resposta ou credencial.
  console.error("Falha ao autenticar como o app ou ao consultar o GitHub (rede, credenciais ou limite). Nada foi impresso do erro.");
  process.exit(1);
}
