# Decisões de arquitetura do TreePM

Estas ADRs registram decisões **atuais** da plataforma, numeradas e datadas. Cada documento usa Contexto, Decisão e Consequências. Limites e trabalho futuro não devem ser lidos como recursos já implementados.

Para uma visão navegável do sistema, comece por [../platform-overview.md](../platform-overview.md). Detalhes de implementação permanecem em [../architecture.md](../architecture.md), a visão de produto em [../vision.md](../vision.md) e perguntas ainda abertas em [../open-questions.md](../open-questions.md).

| ADR | Data | Decisão |
| --- | --- | --- |
| [0001 — Visão de produto, público e superfícies](0001-visao-e-publico.md) | 2026-11-04 | Home Prezi, legado completo, admin e hierarquia recursiva. |
| [0002 — Monorepo TypeScript e fronteiras](0002-monorepo-e-fronteiras.md) | 2026-11-04 | Workspaces, ESM, React/Vite, Fastify/zod e domínio puro. |
| [0003 — Tickets, responsáveis e progresso derivado](0003-tickets-e-progresso.md) | 2026-11-04 | Múltiplos responsáveis/componentes e status manual somente em folhas. |
| [0004 — Hierarquia versus dependências](0004-hierarquia-e-dependencias.md) | 2026-11-04 | Entidades e arestas distintas, independentes e estilizáveis. |
| [0005 — Home espacial, layout orbital e LOD](0005-home-espacial.md) | 2026-11-04 | Substituída pela ADR 0013; registro orbital histórico. |
| [0006 — Câmera, gestos e alcance adaptativo](0006-camera-e-gestos.md) | 2026-11-04 | Âncora do mouse, acúmulo de wheel e zoom até toda folha legível. |
| [0007 — Legado, zoom semântico e protótipos DEV](0007-legado-e-prototipos.md) | 2026-11-04 | Compactação bottom-up, WheelAnchor, views e referências DEV. |
| [0008 — API REST e integridade](0008-api-e-integridade.md) | 2026-11-04 | Validação, ciclos, mutações e delete recursivo seguro. |
| [0009 — Persistência, identidades seed e admin](0009-persistencia-identidade-e-admin.md) | 2026-11-04 | JSON atômico single-process e limites de produção. |
| [0010 — Jev e TypeSafe AI](0010-jev-e-typesafe-ai.md) | 2026-11-04 | Sugestão por níveis somente na API, confiança e fallback manual. |
| [0011 — Performance e renderização](0011-performance-e-renderizacao.md) | 2026-11-04 | TreeIndex, caches, DOM/SVG, culling e tradeoffs. |
| [0012 — Segurança, configuração e validação](0012-seguranca-configuracao-e-validacao.md) | 2026-11-04 | Ports, segredos, comandos e harnesses temporários. |
| [0013 — Regiões retangulares uniformes](0013-regioes-retangulares-uniformes.md) | 2026-11-04 | Filhos abaixo do pai, slots retangulares, LOD e modo de cores. |
| [0014 — Continuidade entre indicador e ticket](0014-continuidade-indicador-ticket.md) | 2026-11-04 | Uma representação por ticket, translação e escala reversíveis pelo zoom. |
| [0015 — Pan imediato e wheel simultâneo](0015-pan-imediato-e-wheel-simultaneo.md) | 2026-11-04 | Home sem cooldown para drag, com pan e zoom simultâneos e âncora preservada. |

Novas decisões devem usar o próximo número sequencial, registrar data e consequências e atualizar este índice. Uma ADR substituída permanece no histórico; a nova deve apontar para ela.
