import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { CanActivate } from "@nestjs/common";
import { CONFIG, linearEnabled } from "../config.js";
import type { AppConfig } from "../config.js";

/** Sem `CREDENTIALS_ENCRYPTION_KEY` (ADR 0060) as rotas do Linear respondem 503 `linear_not_configured`, antes de qualquer validação. */
@Injectable()
export class LinearEnabledGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(): boolean {
    if (!linearEnabled(this.config)) {
      throw new ServiceUnavailableException({ code: "linear_not_configured", message: "A ligação com o Linear não está configurada neste servidor." });
    }
    return true;
  }
}
