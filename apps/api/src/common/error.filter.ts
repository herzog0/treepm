import { Catch, HttpException, HttpStatus, Logger } from "@nestjs/common";
import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";

type ErrorBody = { error: { code: string; message: string } };

const CODES: Record<number, string> = {
  [HttpStatus.BAD_REQUEST]: "validation_error",
  [HttpStatus.UNAUTHORIZED]: "unauthenticated",
  [HttpStatus.FORBIDDEN]: "forbidden",
  [HttpStatus.NOT_FOUND]: "not_found",
  [HttpStatus.CONFLICT]: "conflict",
  [HttpStatus.SERVICE_UNAVAILABLE]: "service_unavailable",
};

const INTERNAL_MESSAGE = "Erro interno do servidor.";

const PARENT_FK = "tickets_org_id_project_id_parent_id_parent_kind_fkey";

/**
 * Corrida na regra "só agrupador tem filhos" (ADR 0031): a conferência da API passou, mas o banco recusou pela chave
 * estrangeira do pai (23503 ou 23001). Vira 409 sem a mensagem do banco. Recusa ao gravar o filho (insert ou update
 * dele): o pai deixou de ser agrupador. Recusa ao mexer no pai (update do tipo ou delete): ele ganhou filho.
 */
export function parentRuleConflict(exception: unknown): { code: string; message: string } | null {
  const cause = (exception as { meta?: { driverAdapterError?: { cause?: { originalCode?: string; originalMessage?: string } } } })
    ?.meta?.driverAdapterError?.cause;
  if (!cause || (cause.originalCode !== "23503" && cause.originalCode !== "23001")) return null;
  const message = cause.originalMessage ?? "";
  if (!message.includes(PARENT_FK)) return null;
  if (message.startsWith("insert or update")) {
    return { code: "parent_not_group", message: "Só um agrupador pode ter filhos; o pai escolhido mudou." };
  }
  return { code: "ticket_has_children", message: "O agrupador ganhou filhos; mova ou remova os filhos antes." };
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
      const custom = typeof payload === "object" ? (payload as { code?: unknown; message?: unknown }) : {};
      response.status(status).json({
        error: {
          code: typeof custom.code === "string" ? custom.code : (CODES[status] ?? "error"),
          message: typeof custom.message === "string" ? custom.message : exception.message,
        },
      });
      return;
    }

    const conflict = parentRuleConflict(exception);
    if (conflict) {
      response.status(HttpStatus.CONFLICT).json({ error: conflict });
      return;
    }

    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: "internal_error", message: INTERNAL_MESSAGE },
    });
  }
}
