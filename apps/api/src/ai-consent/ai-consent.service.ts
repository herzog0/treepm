import { ConflictException, Inject, Injectable } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { AI_CONSENT_VERSION, isAiConsentInForce } from "@treepm/domain";
import type { AiConsentKind } from "@treepm/domain";
import { AuthorizationService } from "../access/authorization.service.js";
import type { Principal } from "../access/principal.js";
import { ActivityService } from "../activity/activity.service.js";
import { parseOutput } from "../common/zod.js";
import { assistantConsentInForce } from "./consent-check.js";
import { consentStateSchema } from "./ai-consent.schema.js";
import type { ConsentState } from "./ai-consent.schema.js";

type OpenRow = { kind: string; documentVersion: string; acceptedAt: Date; withdrawnAt: Date | null; acceptedBy: { displayName: string } };

function consentView(row: OpenRow | undefined) {
  return {
    inForce: row ? isAiConsentInForce({ version: row.documentVersion, withdrawnAt: row.withdrawnAt }) : false,
    version: row?.documentVersion ?? null,
    acceptedBy: row?.acceptedBy.displayName ?? null,
    acceptedAt: row?.acceptedAt.toISOString() ?? null,
    outdated: row !== undefined && row.documentVersion !== AI_CONSENT_VERSION,
  };
}

/**
 * Aceite da organização para a IA (ADR 0039): ler o estado, aceitar e retirar. Cada aceitar cria uma linha; retirar
 * preenche a retirada da linha aberta; as antigas ficam como registro. Só administrador aceita e retira.
 */
@Injectable()
export class AiConsentService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(ActivityService) private readonly activity: ActivityService,
  ) {}

  /** Qualquer membro lê. */
  async state(tx: TenantClient, orgId: string): Promise<ConsentState> {
    const open = await tx.organizationConsent.findMany({
      where: { orgId, withdrawnAt: null },
      select: { kind: true, documentVersion: true, acceptedAt: true, withdrawnAt: true, acceptedBy: { select: { displayName: true } } },
    });
    const byKind = (kind: AiConsentKind) => open.find((row) => row.kind === kind);
    const githubConnected = (await tx.githubInstallation.findFirst({ where: { orgId }, select: { id: true } })) !== null;
    const assistant = consentView(byKind("assistant"));
    return parseOutput(consentStateSchema, {
      currentVersion: AI_CONSENT_VERSION,
      assistant,
      codeReading: { ...consentView(byKind("code_reading")), githubConnected, offerable: githubConnected && assistant.inForce },
    });
  }

  async accept(tx: TenantClient, principal: Principal, kind: AiConsentKind, version: string): Promise<ConsentState> {
    this.authorization.manageAiConsent(principal.actor);
    const { orgId } = principal.organization;
    if (version !== AI_CONSENT_VERSION) {
      throw new ConflictException({ code: "consent_version_changed", message: "Os documentos mudaram. Recarregue a página e leia a versão atual." });
    }
    await this.lock(tx, orgId);
    if (kind === "code_reading") {
      if (!(await assistantConsentInForce(tx, orgId))) {
        throw new ConflictException({ code: "assistant_consent_required_first", message: "Aceite o assistente de IA antes da leitura de código." });
      }
      if ((await tx.githubInstallation.findFirst({ where: { orgId }, select: { id: true } })) === null) {
        throw new ConflictException({ code: "github_not_connected", message: "Ligue o GitHub à organização para oferecer a leitura de código." });
      }
    }
    const open = await tx.organizationConsent.findFirst({ where: { orgId, kind, withdrawnAt: null } });
    if (open && isAiConsentInForce({ version: open.documentVersion, withdrawnAt: null })) return this.state(tx, orgId); // idempotente
    const now = new Date();
    if (open) {
      // Versão antiga em vigor: encerra a linha antiga e abre a nova (a antiga fica como registro).
      await tx.organizationConsent.update({
        where: { orgId_id: { orgId, id: open.id } },
        data: { withdrawnAt: now, withdrawnByPersonId: principal.person.id },
      });
    }
    await tx.organizationConsent.create({ data: { orgId, kind, documentVersion: AI_CONSENT_VERSION, acceptedByPersonId: principal.person.id, acceptedAt: now } });
    await this.activity.record(tx, principal, {
      kind: "organization.ai_consent_accepted",
      subjectType: "organization",
      subjectId: orgId,
      payload: { kind, version: AI_CONSENT_VERSION },
    });
    return this.state(tx, orgId);
  }

  async withdraw(tx: TenantClient, principal: Principal, kind: AiConsentKind): Promise<ConsentState> {
    this.authorization.manageAiConsent(principal.actor);
    const { orgId } = principal.organization;
    await this.lock(tx, orgId);
    // Retirar o assistente retira também a leitura de código, na mesma transação (ela depende dele).
    const kinds: AiConsentKind[] = kind === "assistant" ? ["assistant", "code_reading"] : ["code_reading"];
    const now = new Date();
    for (const each of kinds) {
      const open = await tx.organizationConsent.findFirst({ where: { orgId, kind: each, withdrawnAt: null } });
      if (!open) continue;
      await tx.organizationConsent.update({
        where: { orgId_id: { orgId, id: open.id } },
        data: { withdrawnAt: now, withdrawnByPersonId: principal.person.id },
      });
      await this.activity.record(tx, principal, {
        kind: "organization.ai_consent_withdrawn",
        subjectType: "organization",
        subjectId: orgId,
        payload: { kind: each, version: open.documentVersion },
      });
    }
    return this.state(tx, orgId);
  }

  /** Serializa aceitar e retirar da mesma organização: sem isto, dois administradores simultâneos esbarrariam no índice único. */
  private async lock(tx: TenantClient, orgId: string): Promise<void> {
    await tx.$queryRaw`select 1 from organizations where org_id = ${orgId} for update`;
  }
}
