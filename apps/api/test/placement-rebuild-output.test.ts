import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";

/**
 * TREEPM-325: a saída da ferramenta era cortada em 65 536 bytes (a capacidade do pipe) quando o processo terminava com
 * `process.exit` antes de a saída padrão esvaziar. O leitor aqui só começa a ler depois de o filho ter terminado de escrever.
 */
async function runChild(count: number): Promise<{ stdout: string; code: number | null }> {
  const child = spawn("pnpm", ["exec", "tsx", "--tsconfig", "tsconfig.json", "test/fixtures/placement-rebuild-big-list-child.ts", String(count)], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  await sleep(1500); // o filho já escreveu o que o pipe aceitou e espera por nós
  const chunks: Buffer[] = [];
  for await (const chunk of child.stdout) chunks.push(chunk as Buffer);
  return { stdout: Buffer.concat(chunks).toString("utf8"), code: await closed };
}

describe("saída dos comandos de ticket por um pipe", () => {
  it("ticket-list --json de 2 000 tickets chega inteiro e válido a um leitor lento", async () => {
    const { stdout, code } = await runChild(2000);
    expect(code).toBe(0);
    expect(Buffer.byteLength(stdout)).toBeGreaterThan(300_000);
    const parsed = JSON.parse(stdout) as { number: number }[];
    expect(parsed).toHaveLength(2000);
    expect(parsed[1999]?.number).toBe(2000);
  }, 60_000);
});
