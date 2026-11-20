import { Injectable } from "@nestjs/common";
import type { Prisma, TenantClient } from "@treepm/db";
import type { Principal } from "../access/principal.js";

export type ActivityInput = {
  /** Identificador estável em inglês, ex.: `team.created`. */
  kind: string;
  subjectType: "team" | "area" | "project" | "ticket";
  subjectId: string;
  payload?: Prisma.InputJsonObject;
};

/** Registro de atividade: sempre na mesma transação da mutação que o originou. */
@Injectable()
export class ActivityService {
  async record(tx: TenantClient, principal: Principal, input: ActivityInput): Promise<void> {
    await tx.activityEvent.create({
      data: {
        orgId: principal.organization.orgId,
        actorPersonId: principal.person.id,
        kind: input.kind,
        subjectType: input.subjectType,
        subjectId: input.subjectId,
        payload: input.payload ?? {},
      },
    });
  }
}
