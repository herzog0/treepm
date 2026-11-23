import { constants } from "node:zlib";
import type { RequestHandler, Request, Response } from "express";
import compression from "compression";

/** Abaixo disto a resposta fica como está: o cabeçalho e o custo de CPU não se pagam. */
const THRESHOLD_BYTES = 1024;
/** Brotli 4 e gzip 4: ~10x no JSON da lista, por uma fração do tempo dos níveis altos (medição em `docs/medicoes/`). */
const BROTLI_QUALITY = 4;
const GZIP_LEVEL = 4;

const MCP_PREFIX = "/api/mcp";
/**
 * Respostas que carregam segredo e nunca são comprimidas (ataque do tipo BREACH: segredo e texto escolhido por quem
 * ataca no mesmo corpo comprimido deixam o tamanho vazar o segredo). O token de acesso aparece uma vez, na criação,
 * junto do nome que o usuário escolheu; a conexão do GitHub devolve a URL com o `state` assinado.
 */
const SECRET_ROUTES: readonly { method: string; path: string }[] = [
  { method: "POST", path: "/api/access-tokens" },
  { method: "POST", path: "/api/github/connect" },
  { method: "POST", path: "/api/github/connect/complete" },
];

function contentType(res: Response): string {
  const value = res.getHeader("Content-Type");
  return typeof value === "string" ? value.toLowerCase() : "";
}

/** `true` quando a resposta pode ser comprimida. `no-transform` já é respeitado pela biblioteca. */
export function shouldCompress(req: Pick<Request, "method" | "path">, res: Pick<Response, "getHeader" | "statusCode">): boolean {
  if (req.path === MCP_PREFIX || req.path.startsWith(`${MCP_PREFIX}/`)) return false;
  if (SECRET_ROUTES.some((route) => route.method === req.method && route.path === req.path)) return false;
  if (res.statusCode === 206) return false;
  const type = contentType(res as Response);
  if (type.startsWith("text/event-stream")) return false;
  return /^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg\+xml)/.test(type) || type.includes("+json");
}

/** Compressão das respostas HTTP (brotli e gzip pelo `Accept-Encoding`), registrada antes de tudo que escreve corpo. */
export function compressionMiddleware(): RequestHandler {
  return compression({
    threshold: THRESHOLD_BYTES,
    level: GZIP_LEVEL,
    brotli: { params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY } },
    filter: (req, res) => shouldCompress(req, res),
  });
}
