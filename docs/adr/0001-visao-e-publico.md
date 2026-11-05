# ADR 0001 — Visão de produto, público e superfícies

**Status:** Aceita
**Data:** 2026-11-04

## Contexto

O TreePM organiza trabalho recursivo, inclusive o volume de subtarefas produzido com apoio de IA. Pessoas de produto, design e engenharia precisam entender contexto, progresso e relações sem depender de um único responsável ou de uma lista linear. A plataforma também precisa de uma superfície operacional para inspecionar o workspace local.

## Decisão

- A home `/` é a experiência principal: uma constelação espacial Prezi para navegar por proximidade, escala e agregação.
- `/legacy` conserva a árvore top-down completa, Lista, Kanban, detalhes, formulários e conexões. Não é uma rota de segunda classe nem uma versão com dados diferentes.
- O admin em `5174` é um backoffice inicial de leitura operacional, com visão geral, projetos, tickets e usuários seed que consomem a mesma API.
- Tickets formam uma hierarquia recursiva com um `parentId` nullable e sem limite artificial de profundidade. Tickets e componentes aceitam múltiplos responsáveis; não existe owner único.
- A audiência atual é de desenvolvimento e avaliação local. Usuários seed são identidades demonstrativas, não contas autenticadas.

## Consequências

As três superfícies compartilham dados e regras, mas têm objetivos de apresentação diferentes. A home não precisa reproduzir arestas top-down ou Kanban; o legado não precisa imitar a constelação.

Não há login, permissões, colaboração em tempo real, billing ou proteção do backoffice nesta fatia. Esses recursos são futuros e estão relacionados em `docs/open-questions.md`; não devem ser presumidos na UI ou na API. A direção visual e o vocabulário de produto são mantidos em `docs/vision.md`.
