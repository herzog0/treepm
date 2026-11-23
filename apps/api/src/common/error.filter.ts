import { Catch, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";

type ErrorBody = { error: { code: string; message: string; details?: Record<string, unknown> } };

const CODES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: "validation_error",
  [HttpStatus.UNAUTHORIZED]: "unauthenticated",
  [HttpStatus.FORBIDDEN]: "forbidden",
  [HttpStatus.NOT_FOUND]: "not_found",
  [HttpStatus.CONFLICT]: "conflict",
  [HttpStatus.SERVICE_UNAVAILABLE]: "service_unavailable",
};

const INTERNAL_MESSAGE = "Erro interno do servidor.";

const PARENT_FK = "tickets_org_id_project_id_parent_id_fkey";

/**
 * Corrida na regra do pai (ADR 0034): a conferência da API passou, mas o banco recusou pela chave estrangeira do pai
 * (23503 ou 23001). Vira resposta sem a mensagem do banco. Recusa ao gravar o filho (insert ou update dele): o pai foi
 * removido enquanto isso, 404. Recusa ao mexer no pai (delete): ele ganhou filho, 409 `ticket_has_children`.
 */
export function parentRuleConflict(exception: unknown): { status: number; code: string; message: string } | null {
  const cause = (exception as { meta?: { driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } } } })
    ?.meta?.driverAdapterError?.cause;
  if (!cause || (cause.originalCode !== "23503" && cause.originalCode !== "23001")) return null;
  const message = cause.originalMessage ?? "";
  if (!message.includes(PARENT_FK)) return null;
  if (message.startsWith("insert or update")) {
    return { status: HttpStatus.NOT_FOUND, code: "not_found", message: "Ticket pai não encontrado." };
  }
  return { status: HttpStatus.CONFLICT, code: "ticket_has_children", message: "O ticket ganhou filhos; mova ou remova os filhos antes." };
}

/**
 * Impasse entre travas de linha (40P01) ou falha de serialização (40001): o PostgreSQL abortou esta transação para as outras
 * seguirem. Nada foi gravado; vira 409 `concurrent_update` ("tente de novo"), não 500 (ADR 0045, revisão 1).
 */
export function retryableConflict(exception: unknown): { status: number; code: string; message: string } | null {
  const e = exception as {
    code?: unknown;
    message?: unknown;
    meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } };
  };
  const codes = [e?.code, e?.meta?.code, e?.meta?.driverAdapterError?.cause?.originalCode];
  const texts = [e?.message, e?.meta?.driverAdapterError?.cause?.originalMessage];
  const hit = codes.some((c) => c === "40P01" || c === "40001") || texts.some((t) => typeof t === "string" && /40P01|40001|deadlock detected/.test(t));
  if (!hit) return null;
  return { status: HttpStatus.CONFLICT, code: "concurrent_update", message: "Outra alteração aconteceu ao mesmo tempo. Tente de novo." };
}

/** Formato único `{ error: { code, message } }`; erros internos nunca vazam detalhes. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger("ErrorFilter");

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<{
      status(code: number): { json(body: ErrorBody): void };
    }>();

    // 503 só nasce de exceção lançada de propósito (ex.: `assistant_unavailable`); os demais 5xx seguem opacos.
    if (
      exception instanceof HttpException &&
      (exception.getStatus() < 500 || exception.getStatus() === HttpStatus.SERVICE_UNAVAILABLE)
    ) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      const custom = typeof payload === "object" ? (payload as { code?: unknown; message?: unknown; details?: unknown }) : {};
      const details =
        typeof custom.details === "object" && custom.details !== null ? (custom.details as Record<string, unknown>) : undefined;
      response.status(status).json({
        error: {
          code: typeof custom.code === "string" ? custom.code : (CODES[status] ?? "error"),
          message: typeof custom.message === "string" ? custom.message : exception.message,
          ...(details ? { details } : {}),
        },
      });
      return;
    }

    const conflict = parentRuleConflict(exception) ?? retryableConflict(exception);
    if (conflict) {
      response.status(conflict.status).json({ error: { code: conflict.code, message: conflict.message } });
      return;
    }

    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: "internal_error", message: INTERNAL_MESSAGE },
    });
  }
}
