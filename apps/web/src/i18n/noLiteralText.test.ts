import { resolve } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const root = `${resolve(import.meta.dirname, "../../../..")}/`;
const eslint = new ESLint({ cwd: root });

async function lint(code: string, area: string, file = "Fake.tsx") {
  const [result] = await eslint.lintText(code, { filePath: `${root}apps/web/src/${area}${file}` });
  return result!.messages.filter((message) => message.ruleId === "treepm/no-literal-ui-text").map((message) => message.message);
}

const component = (body: string) => `export function Fake() { return (${body}); }`;

describe("no-literal-ui-text", () => {
  it.each([
    ["text inside JSX", "<p>Olá, mundo</p>"],
    ["text next to an element", "<p><b>·</b> e mais texto</p>"],
    ["aria-label", '<button aria-label="Fechar">·</button>'],
    ["title", '<a title="Dica" />'],
    ["placeholder", '<input placeholder="Digite" />'],
    ["alt", '<img alt="Logo" />'],
    ["attribute with a string expression", '<a title={"Dica"} />'],
    ["a string literal in a JSX expression", '<p>{"Texto solto"}</p>'],
  ])("flags %s in a converted area", async (_name, jsx) => {
    for (const area of ["teams/", "settings/", "nav/", "preferences/", ""]) {
      expect(await lint(component(jsx), area)).toHaveLength(1);
    }
  });

  it("accepts text that comes from the catalog and non-text literals", async () => {
    const code = `
      import { useTranslation } from "react-i18next";
      export function Fake({ n }: { n: number }) {
        const { t } = useTranslation("teams");
        return (<section className="a" role="status" aria-label={t("x")} data-x="y"><p>{t("y")}</p><span>{n}</span><span>·</span><span>…</span><input type="text" name="q" /></section>);
      }`;
    expect(await lint(code, "teams/")).toEqual([]);
  });

  it("does not look at tests", async () => {
    expect(await lint(component("<p>Olá</p>"), "teams/", "Fake.test.tsx")).toEqual([]);
  });

  it("does not look at areas still pending conversion", async () => {
    for (const area of ["panel/", "ticket/", "tickets/", "import/", "github/", "map/", "assistant/", "api/", "demo/"]) {
      expect(await lint(component("<p>Olá</p>"), area)).toEqual([]);
    }
  });
});
