import { AI_CONSENT_VERSION } from "@treepm/domain";
import { describe, expect, it } from "vitest";
import type { TenantClient } from "@treepm/db";
import { assistantConsentInForce, codeReadingConsentInForce, requireAssistantConsent, requireCodeReadingConsent } from "../src/ai-consent/consent-check.js";

type Row = { kind: string; documentVersion: string; withdrawnAt: Date | null };

/** `tx` falso: só `organizationConsent.findFirst`, filtrando pelo tipo e por `withdrawnAt: null` como a conferência pede. */
function fakeTx(rows: Row[]): TenantClient {
  return {
    organizationConsent: {
      findFirst: ({ where }: { where: { kind: string; withdrawnAt: null } }) =>
        Promise.resolve(rows.find((row) => row.kind === where.kind && row.withdrawnAt === null) ?? null),
    },
  } as unknown as TenantClient;
}

const assistant: Row = { kind: "assistant", documentVersion: AI_CONSENT_VERSION, withdrawnAt: null };
const code: Row = { kind: "code_reading", documentVersion: AI_CONSENT_VERSION, withdrawnAt: null };

describe("conferência do aceite do assistente", () => {
  it("em vigor só com a linha aberta da versão atual", async () => {
    expect(await assistantConsentInForce(fakeTx([assistant]), "org")).toBe(true);
    expect(await assistantConsentInForce(fakeTx([]), "org")).toBe(false);
    expect(await assistantConsentInForce(fakeTx([{ ...assistant, documentVersion: "rascunho-0" }]), "org")).toBe(false);
    // ADR 0053: o texto novo cita a Voyage AI, então o aceite dado ao rascunho anterior deixou de valer.
    expect(await assistantConsentInForce(fakeTx([{ ...assistant, documentVersion: "rascunho-1" }]), "org")).toBe(false);
    expect(await assistantConsentInForce(fakeTx([{ ...assistant, withdrawnAt: new Date() }]), "org")).toBe(false);
    expect(await assistantConsentInForce(fakeTx([code]), "org")).toBe(false);
  });

  it("require lança 403 assistant_consent_required sem o aceite", async () => {
    await expect(requireAssistantConsent(fakeTx([]), "org")).rejects.toMatchObject({ status: 403, response: { code: "assistant_consent_required" } });
    await expect(requireAssistantConsent(fakeTx([assistant]), "org")).resolves.toBeUndefined();
  });
});

describe("conferência do aceite da leitura de código (ainda sem consumidor: o TREEPM-82 vai usar)", () => {
  it("exige os dois aceites em vigor: code_reading sozinho não basta", async () => {
    expect(await codeReadingConsentInForce(fakeTx([assistant, code]), "org")).toBe(true);
    expect(await codeReadingConsentInForce(fakeTx([code]), "org")).toBe(false);
    expect(await codeReadingConsentInForce(fakeTx([assistant]), "org")).toBe(false);
    expect(await codeReadingConsentInForce(fakeTx([assistant, { ...code, documentVersion: "rascunho-0" }]), "org")).toBe(false);
    expect(await codeReadingConsentInForce(fakeTx([{ ...assistant, withdrawnAt: new Date() }, code]), "org")).toBe(false);
  });

  it("require lança 403 code_reading_consent_required", async () => {
    await expect(requireCodeReadingConsent(fakeTx([assistant]), "org")).rejects.toMatchObject({ status: 403, response: { code: "code_reading_consent_required" } });
    await expect(requireCodeReadingConsent(fakeTx([assistant, code]), "org")).resolves.toBeUndefined();
  });
});
