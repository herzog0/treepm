import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { CanActivate } from "@nestjs/common";
import { CONFIG, githubEnabled } from "../config.js";
import type { AppConfig } from "../config.js";

/** Com o GitHub desligado (ADR 0032) toda rota da ligação responde 404 `github_disabled`, antes de qualquer validação. */
@Injectable()
export class GithubEnabledGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  canActivate(): boolean {
    if (!githubEnabled(this.config)) {
      throw new NotFoundException({ code: "github_disabled", message: "A ligação com o GitHub não está ligada." });
    }
    return true;
  }
}
