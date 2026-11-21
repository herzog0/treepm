import { describe, expect, it } from "vitest";
import { clerkLocalization } from "./clerk.js";

describe("clerkLocalization", () => {
  it("picks the Clerk translation of the active language", () => {
    expect(clerkLocalization("pt-BR").locale).toBe("pt-BR");
    expect(clerkLocalization("en").locale).toBe("en-US");
    expect(clerkLocalization("es-MX").locale).toBe("es-MX");
  });

  it.each([
    ["pt-BR", "Crie uma senha"],
    ["en", "Create a password"],
    ["es-MX", "Crea una contraseña"],
  ] as const)("keeps the sign-up password placeholder adjustment in %s", (language, expected) => {
    expect(clerkLocalization(language).formFieldInputPlaceholder__signUpPassword).toBe(expected);
  });
});
