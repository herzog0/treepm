/**
 * Todos os catálogos, embutidos no pacote (sem carregamento assíncrono). Os tipos das chaves saem do catálogo
 * `pt-BR`; cada área tem o seu arquivo em `locales/<idioma>/<área>.json`, e uma área nova se registra aqui nos
 * três idiomas. O teste de paridade confere que nenhum arquivo ficou de fora.
 */
import enApi from "./locales/en/api.json";
import enApp from "./locales/en/app.json";
import enAssistant from "./locales/en/assistant.json";
import enDemo from "./locales/en/demo.json";
import enGithub from "./locales/en/github.json";
import enImport from "./locales/en/import.json";
import enMap from "./locales/en/map.json";
import enNav from "./locales/en/nav.json";
import enPanel from "./locales/en/panel.json";
import enSettings from "./locales/en/settings.json";
import enTeams from "./locales/en/teams.json";
import enTicket from "./locales/en/ticket.json";
import enTickets from "./locales/en/tickets.json";
import esApi from "./locales/es-MX/api.json";
import esApp from "./locales/es-MX/app.json";
import esAssistant from "./locales/es-MX/assistant.json";
import esDemo from "./locales/es-MX/demo.json";
import esGithub from "./locales/es-MX/github.json";
import esImport from "./locales/es-MX/import.json";
import esMap from "./locales/es-MX/map.json";
import esNav from "./locales/es-MX/nav.json";
import esPanel from "./locales/es-MX/panel.json";
import esSettings from "./locales/es-MX/settings.json";
import esTeams from "./locales/es-MX/teams.json";
import esTicket from "./locales/es-MX/ticket.json";
import esTickets from "./locales/es-MX/tickets.json";
import ptApi from "./locales/pt-BR/api.json";
import ptApp from "./locales/pt-BR/app.json";
import ptAssistant from "./locales/pt-BR/assistant.json";
import ptDemo from "./locales/pt-BR/demo.json";
import ptGithub from "./locales/pt-BR/github.json";
import ptImport from "./locales/pt-BR/import.json";
import ptMap from "./locales/pt-BR/map.json";
import ptNav from "./locales/pt-BR/nav.json";
import ptPanel from "./locales/pt-BR/panel.json";
import ptSettings from "./locales/pt-BR/settings.json";
import ptTeams from "./locales/pt-BR/teams.json";
import ptTicket from "./locales/pt-BR/ticket.json";
import ptTickets from "./locales/pt-BR/tickets.json";

export const resources = {
  "pt-BR": { api: ptApi, app: ptApp, assistant: ptAssistant, demo: ptDemo, github: ptGithub, import: ptImport, map: ptMap, nav: ptNav, panel: ptPanel, settings: ptSettings, teams: ptTeams, ticket: ptTicket, tickets: ptTickets },
  en: { api: enApi, app: enApp, assistant: enAssistant, demo: enDemo, github: enGithub, import: enImport, map: enMap, nav: enNav, panel: enPanel, settings: enSettings, teams: enTeams, ticket: enTicket, tickets: enTickets },
  "es-MX": { api: esApi, app: esApp, assistant: esAssistant, demo: esDemo, github: esGithub, import: esImport, map: esMap, nav: esNav, panel: esPanel, settings: esSettings, teams: esTeams, ticket: esTicket, tickets: esTickets },
};

export type Resources = (typeof resources)["pt-BR"];
