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

    this.logger.error(exception instanceof Error ? (exception.stack ?? exception.message) : String(exception));
    response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: "internal_error", message: INTERNAL_MESSAGE },
    });
  }
}
