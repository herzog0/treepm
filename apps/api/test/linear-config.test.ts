import { describe, expect, it } from "vitest";
import { ConfigError, linearEnabled, loadConfig } from "../src/config.js";

const valid = {
  DATABASE_URL: "postgresql://treepm_app:x@localhost:5432/db",
  CLERK_SECRET_KEY: "sk_test_x",
  CLERK_PUBLISHABLE_KEY: "pk_test_x",
  APP_ORIGIN: "https://treepm.ai",
};
const key32 = Buffer.alloc(32, 7).toString("base64");

describe("CREDENTIALS_ENCRYPTION_KEY (ADR 0060)", () => {
  it("é opcional: sem ela a ligação com o Linear fica desligada", () => {
    const config = loadConfig(valid);
    expect(config.CREDENTIALS_ENCRYPTION_KEY).toBeUndefined();
    expect(linearEnabled(config)).toBe(false);
  });

  it("aceita base64 de exatamente 32 bytes e liga o Linear", () => {
    const config = loadConfig({ ...valid, CREDENTIALS_ENCRYPTION_KEY: key32 });
    expect(linearEnabled(config)).toBe(true);
  });

  it("string vazia vale como ausente", () => {
    expect(linearEnabled(loadConfig({ ...valid, CREDENTIALS_ENCRYPTION_KEY: "" }))).toBe(false);
  });

  it.each([
    ["31 bytes", Buffer.alloc(31, 1).toString("base64")],
    ["33 bytes", Buffer.alloc(33, 1).toString("base64")],
    ["não é base64", "isto não é base64 !!!"],
  ])("recusa %s, citando só o nome da variável", (_name, value) => {
    expect(() => loadConfig({ ...valid, CREDENTIALS_ENCRYPTION_KEY: value })).toThrow(ConfigError);
    try {
      loadConfig({ ...valid, CREDENTIALS_ENCRYPTION_KEY: value });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("CREDENTIALS_ENCRYPTION_KEY");
      expect(message).not.toContain(value);
    }
  });
});
