import { Injectable } from "@nestjs/common";
import type { Prisma, TenantClient } from "@treepm/db";
import type { Principal } from "../access/principal.js";

export type ActivityInput = {
  /** Identificador estável em inglês, ex.: `team.created`. */
  kind: string;
  subjectType: "organization" | "team" | "area" | "project" | "ticket";
  subjectId: string;
  payload?: Prisma.InputJsonObject;
};

/** Registro de atividade: sempre na mesma transação da mutação que o originou. */
@Injectable()
export class ActivityService {
  async record(tx: TenantClient, principal: Principal, input: ActivityInput): Promise<void> {
    await tx.activityEvent.create({ data: this.row(principal, input) });
  }

  /** Vários eventos de uma vez, numa só inserção (o custo não cresce com a quantidade). */
  async recordMany(tx: TenantClient, principal: Principal, inputs: readonly ActivityInput[]): Promise<void> {
    if (inputs.length === 0) return;
    await tx.activityEvent.createMany({ data: inputs.map((input) => this.row(principal, input)) });
  }

  private row(principal: Principal, input: ActivityInput) {
    return {
      orgId: principal.organization.orgId,
      actorPersonId: principal.person.id,
      kind: input.kind,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      // Quem agiu pelo MCP fica no próprio evento (ADR 0043): a origem e o id do token, nunca o segredo.
      // Agindo como pessoa de teste (ADR 0057): a origem e a pessoa de verdade (o administrador) ficam no evento; a leitura pública não os devolve.
      payload:
        principal.via?.kind === "mcp"
          ? { ...(input.payload ?? {}), via: principal.via.kind, tokenId: principal.via.tokenId }
          : principal.via?.kind === "act-as"
            ? { ...(input.payload ?? {}), via: principal.via.kind, realPersonId: principal.via.realPersonId }
            : (input.payload ?? {}),
    };
  }
}
