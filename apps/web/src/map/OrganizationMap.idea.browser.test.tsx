import { useState } from "react";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import { makePanelMe, makePerson } from "../panel/testing.js";
import { makeProject, makeTicket, makeTreeClient } from "../test/fakes.js";
import { OrganizationMap } from "./OrganizationMap.js";

// ADR 0042, fatia 2, em navegador real: o mapa de verdade, com o tema do app, com dois ramos comuns e ramos de ideia.
// As capturas de conferência visual saem em `__screenshots__` ao lado deste arquivo; quem confere as move e apaga a pasta.
const shot = async (name: string) => {
  await page.screenshot({ path: `${name}.png` });
};

const project = makeProject("p1", "ALFA", "Projeto Alfa");
const tickets = () => [
  makeTicket("t1", "p1", 1, "Acesso e conta", { key: "ALFA-1", status: "in_progress", descriptionExcerpt: "Login, senha e sessão." }),
  makeTicket("t2", "p1", 2, "Login com Google", { key: "ALFA-2", parentId: "t1", status: "in_progress" }),
  makeTicket("t3", "p1", 3, "Recuperar senha", { key: "ALFA-3", parentId: "t1", status: "done" }),
  makeTicket("t4", "p1", 4, "Publicação", { key: "ALFA-4", status: "in_review", descriptionExcerpt: "Levar o aplicativo às lojas." }),
  makeTicket("t5", "p1", 5, "Textos da loja", { key: "ALFA-5", parentId: "t4", status: "todo" }),
  makeTicket("t6", "p1", 6, "Capturas de tela", { key: "ALFA-6", parentId: "t4", status: "in_review" }),
  // Uma ideia pequena dentro de um ramo comum.
  makeTicket("t7", "p1", 7, "Vídeo de apresentação", { key: "ALFA-7", parentId: "t4", idea: { root: true, stage: "new" } }),
  // Um ramo de ideia com filhos.
  makeTicket("i1", "p1", 8, "Busca por voz", { key: "ALFA-8", idea: { root: true, stage: "refining" }, descriptionExcerpt: "Falar em vez de digitar." }),
  makeTicket("i2", "p1", 9, "Reconhecer comandos", { key: "ALFA-9", parentId: "i1", status: "done" }),
  makeTicket("i3", "p1", 10, "Responder em voz alta", { key: "ALFA-10", parentId: "i1" }),
  // Ideia descartada.
  makeTicket("d1", "p1", 11, "Modo offline", { key: "ALFA-11", idea: { root: true, stage: "discarded" } }),
  makeTicket("d2", "p1", 12, "Sincronizar depois", { key: "ALFA-12", parentId: "d1" }),
];

function Harness({ first }: { first: string | null }) {
  const [openId, setOpenId] = useState<string | null>(first);
  const [client] = useState(() => makeTreeClient({ projects: [project], tickets: { p1: tickets() }, people: [makePerson("person-1", "Ana")] }));
  return (
    <main className="tenant-map" style={{ position: "fixed", inset: 0 }}>
      <OrganizationMap client={client} me={makePanelMe("admin")} openTicketId={openId} onOpenTicketChange={setOpenId} />
    </main>
  );
}
const mapWith = (openTicketId: string | null) => <Harness first={openTicketId} />;
const settle = () => new Promise((resolve) => setTimeout(resolve, 700));

describe("ideias no mapa, em navegador real", () => {
  it("desenha ramos comuns e ramos de ideia, aproximado e afastado, com a cor de ideia só nos nós de ideia", async () => {
    await page.viewport(1440, 900);
    // Abrir um ticket enquadra a câmera nele; Esc fecha a página e deixa só o mapa.
    const screen = await render(mapWith("t4"));
    await expect.element(screen.getByRole("heading", { level: 1, name: "Publicação" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await settle();
    await shot("01-ramo-comum-com-ideia-pequena");
    await screen.getByRole("button", { name: "Cores" }).click();
    await settle();
    await shot("02-ramo-comum-com-ideia-pequena-cores");
    await screen.getByRole("button", { name: "Cores" }).click();
    for (let n = 0; n < 3; n += 1) await screen.getByRole("button", { name: "Reduzir zoom" }).click();
    await settle();
    await shot("03-mapa-afastado");
    await screen.getByRole("button", { name: "Cores" }).click();
    await settle();
    await shot("04-mapa-afastado-cores");
  });

  it("a página da raiz de uma ideia, com a triagem, e a de um ticket dentro dela", async () => {
    await page.viewport(1440, 900);
    const root = await render(mapWith("i1"));
    await expect.element(root.getByRole("button", { name: "Aceitar" })).toBeVisible();
    await expect.element(root.getByRole("button", { name: "Descartar" })).toBeVisible();
    await settle();
    await shot("07-pagina-raiz-de-ideia");
    await root.unmount();
    const inside = await render(mapWith("i2"));
    await expect.element(inside.getByText("Parte da ideia", { exact: false }).first()).toBeVisible();
    await settle();
    await shot("08-pagina-ticket-dentro-de-ideia");
    await inside.unmount();
    const discarded = await render(mapWith("d1"));
    await expect.element(discarded.getByRole("button", { name: "Reabrir" })).toBeVisible();
    await settle();
    await shot("05-pagina-ideia-descartada");
    await discarded.getByRole("button", { name: "Cores" }).click();
    await settle();
    await shot("06-ideia-descartada-cores");
  });
});
