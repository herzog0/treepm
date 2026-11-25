import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repo = resolve(import.meta.dirname, "../../../..");
const COPIES = [
  { name: "termos", copy: resolve(import.meta.dirname, "content/pt-BR/termos.md"), source: resolve(repo, "docs/legal/termos-de-uso.md") },
  { name: "privacidade", copy: resolve(import.meta.dirname, "content/pt-BR/privacidade.md"), source: resolve(repo, "docs/legal/politica-de-privacidade.md") },
];

/** Aviso de rascunho e marcadores de pendência (docs/legal/README.md). */
const DRAFT_MARKERS = [/RASCUNHO/, /\[A PREENCHER/, /\[DECIDIR/, /\[REVISÃO JURÍDICA/];

describe("legal content", () => {
  // VERMELHO DE PROPÓSITO (brief L1): fica vermelho até Teodoro aprovar o texto e o rascunho sair dos arquivos.
  // Não desligar, não marcar como skip e não mexer no texto só para ele passar.
  it("legal content is approved for publication", () => {
    const found: string[] = [];
    for (const { copy } of COPIES) {
      readFileSync(copy, "utf8").split("\n").forEach((line, index) => {
        for (const marker of DRAFT_MARKERS) if (marker.test(line)) found.push(`${copy.replace(`${repo}/`, "")}:${index + 1}: ${marker.source.replace("\\", "")} — ${line.trim().slice(0, 80)}`);
      });
    }
    expect(found, `Texto legal ainda é rascunho (${found.length} ocorrência(s)):\n${found.join("\n")}\n`).toEqual([]);
  });

  it.each(COPIES)("the copy of $name inside the web app is identical to docs/legal", ({ copy, source }) => {
    expect(readFileSync(copy, "utf8")).toBe(readFileSync(source, "utf8"));
  });
});
