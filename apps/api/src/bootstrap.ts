import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "./config.js";
import { McpGateway } from "./mcp/mcp-gateway.js";

const MCP_PREFIX = "/api/mcp";
const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_CACHE = "no-cache";

function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

function notFound(res: Response): void {
  res.status(404).json({ error: { code: "not_found", message: "Rota não encontrada." } });
}

/**
 * Serve o web estático na mesma origem (ADR 0022) quando `WEB_DIST_DIR` está definida.
 * Roda como middleware, antes das rotas Nest: nada aqui passa pelo guard nem abre
 * transação, e `/api/*` sempre segue adiante para o roteador (404 JSON da API incluído).
 * Fora de `/api`, o que não for arquivo vira `index.html` (SPA) só para GET/HEAD;
 * o resto, e tudo sem `WEB_DIST_DIR`, responde 404 JSON no formato de erro da API.
 */
function serveWeb(app: INestApplication, webDistDir: string | undefined): void {
  const root = webDistDir === undefined ? undefined : resolve(webDistDir);
  if (root !== undefined) {
    (app as NestExpressApplication).useStaticAssets(root, {
      index: false,
      redirect: false,
      setHeaders: (res, filePath) => {
        res.setHeader("Cache-Control", filePath.startsWith(`${root}/assets/`) ? IMMUTABLE : NO_CACHE);
      },
    });
  }

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isApiPath(req.path)) return next();
    const isGet = req.method === "GET" || req.method === "HEAD";
    if (root === undefined || !isGet || req.path.startsWith("/assets/")) return notFound(res);
    res.setHeader("Cache-Control", NO_CACHE);
    res.sendFile(resolve(root, "index.html"), { cacheControl: false }, (error) => {
      if (error) next(error);
    });
  });
}

/**
 * Entrada do servidor MCP (ADR 0038): `/api/mcp/:projectKey`, sem sessão do Clerk (a autenticação é só o token).
 * É middleware do Express registrado ANTES do leitor de corpo do Nest, para o teto de 64 KB e o limite por IP valerem
 * antes de qualquer leitura de corpo; nada aqui passa pelo guard nem abre transação de sessão. Tudo sob `/api/mcp`
 * é do gateway, inclusive o 404 de caminhos que não são `/api/mcp/<chave>` (a resposta não repete o caminho: ele
 * poderia levar um token colado por engano).
 */
function serveMcp(app: INestApplication): void {
  const gateway = app.get(McpGateway);
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path !== MCP_PREFIX && !req.path.startsWith(`${MCP_PREFIX}/`)) return next();
    gateway.handle(req, res, req.path.slice(MCP_PREFIX.length)).catch(next);
  });
}

/** Configuração HTTP compartilhada entre `main.ts` e os testes. */
export function configureApp(app: INestApplication, config: Pick<AppConfig, "WEB_DIST_DIR">): void {
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();
  serveMcp(app);
  serveWeb(app, config.WEB_DIST_DIR);
}
