import { describe, expect, it } from "vitest";
import type { Actor } from "./index.js";
import {
  AI_CONSENT_KINDS,
  AI_CONSENT_PATHS,
  AI_CONSENT_VERSION,
  canManageAiConsent,
  isAiConsentInForce,
} from "./ai-consent.js";

const member: Actor = { clerkRole: "member", teamRoles: new Map(), projectRoles: new Map() };
const admin: Actor = { ...member, clerkRole: "admin" };

describe("constantes do aceite", () => {
  it("a versão em vigor é rascunho-3, os tipos são assistant e code_reading e os caminhos são fixos", () => {
    expect(AI_CONSENT_VERSION).toBe("rascunho-3");
    expect([...AI_CONSENT_KINDS]).toEqual(["assistant", "code_reading"]);
    expect(AI_CONSENT_PATHS).toEqual({ terms: "/termos", privacy: "/privacidade" });
  });
});

describe("isAiConsentInForce", () => {
  const given = { version: AI_CONSENT_VERSION, withdrawnAt: null };

  it("vale quando existe, não foi retirado e é da versão atual", () => {
    expect(isAiConsentInForce(given)).toBe(true);
  });
  it("não vale quando não existe", () => {
    expect(isAiConsentInForce(null)).toBe(false);
    expect(isAiConsentInForce(undefined)).toBe(false);
  });
  it("não vale quando foi retirado", () => {
    expect(isAiConsentInForce({ ...given, withdrawnAt: new Date() })).toBe(false);
  });
  it("não vale quando é de uma versão antiga", () => {
    expect(isAiConsentInForce({ ...given, version: "rascunho-0" })).toBe(false);
  });
});

describe("canManageAiConsent", () => {
  it("só o administrador da organização", () => {
    expect(canManageAiConsent(admin)).toBe(true);
    expect(canManageAiConsent(member)).toBe(false);
  });
  it("papel de equipe ou de projeto não basta", () => {
    const lead: Actor = { ...member, teamRoles: new Map([["t", "admin"]]), projectRoles: new Map([["p", "manager"]]) };
    expect(canManageAiConsent(lead)).toBe(false);
  });
});
