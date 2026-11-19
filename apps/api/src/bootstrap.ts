import { resolve } from "node:path";
import type { INestApplication } from "@nestjs/common";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { NextFunction, Request, Response } from "express";
import type { AppConfig } from "./config.js";

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

/** Configuração HTTP compartilhada entre `main.ts` e os testes. */
export function configureApp(app: INestApplication, config: Pick<AppConfig, "WEB_DIST_DIR">): void {
  app.setGlobalPrefix("api");
  app.enableShutdownHooks();
  serveWeb(app, config.WEB_DIST_DIR);
}
