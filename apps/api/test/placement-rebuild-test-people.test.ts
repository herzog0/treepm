import { APP_URL } from "@treepm/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bootApp } from "../scripts/placement-rebuild/app.js";
import type { Booted } from "../scripts/placement-rebuild/app.js";
import { ApiClient } from "../scripts/placement-rebuild/client.js";
import { parseCliArgs } from "../scripts/placement-rebuild/core.js";
import { testPersonCreateCommand, testPersonListCommand } from "../scripts/placement-rebuild/test-person-commands.js";

process.env["DATABASE_URL"] = APP_URL;
process.env["CLERK_SECRET_KEY"] = "fake";
process.env["CLERK_PUBLISHABLE_KEY"] = "fake";
process.env["APP_ORIGIN"] = "http://127.0.0.1:4310";
delete process.env["ANTHROPIC_API_KEY"];
delete process.env["TYPESAFE_API_KEY"];

describe("argumentos", () => {
  it("test-person-create pede org, user e name", () => {
    expect(parseCliArgs(["test-person-create", "--org", "o", "--user", "u", "--name", "Bia"])).toMatchObject({ ok: true, command: "test-person-create", options: { name: "Bia" } });
    expect(parseCliArgs(["test-person-create", "--org", "o", "--user", "u"])).toMatchObject({ ok: false });
  });
  it("test-person-list pede org e user e não aceita --name", () => {
    expect(parseCliArgs(["test-person-list", "--org", "o", "--user", "u"])).toMatchObject({ ok: true, command: "test-person-list" });
    expect(parseCliArgs(["test-person-list", "--org", "o", "--user", "u", "--name", "x"])).toMatchObject({ ok: false });
  });
  it("--name não existe nos outros comandos", () => {
    expect(parseCliArgs(["ticket-list", "--org", "o", "--user", "u", "--project", "p", "--name", "x"])).toMatchObject({ ok: false });
  });
});

describe("comandos", () => {
  let booted: Booted;
  let client: ApiClient;
  const lines: string[] = [];
  beforeAll(async () => {
    booted = await bootApp({ org: "org_tp", user: "user_tp", role: "org:admin", fakeProviders: true, fake503First: 0, fake503JudgeAt: 0, needsAi: false });
    client = new ApiClient(booted.baseUrl, booted.token);
  });
  afterAll(async () => {
    await booted.close();
  });

  it("cria e lista pessoas de teste, só com as marcas de teste e sem e-mail", async () => {
    const ctx = { client, project: "", log: (line: string) => lines.push(line) };
    await testPersonCreateCommand(ctx, "Bia");
    expect(lines.join("\n")).toMatch(/Bia/);
    lines.length = 0;
    await testPersonListCommand(ctx);
    const listed = JSON.parse(lines.join("\n")) as { id: string; displayName: string; isTest: boolean }[];
    expect(listed.map((p) => p.displayName)).toContain("Bia");
    expect(listed.every((p) => p.isTest)).toBe(true);
    expect(lines.join("\n")).not.toContain("invalid");
  });
});
