# Instruções do projeto

## Sincronização de instruções

- Toda instrução adicionada ou alterada em `CLAUDE.md` deve ser adicionada ou alterada também em `AGENTS.md` na mesma interação, inclusive esta regra de sincronização.

## Coordenação, decisões e fluxos

- A sessão coordenadora (aba `TreePM Master` do herdr, Claude Fable) nunca escreve código: escreve briefs, ADRs e documentação, revisa diffs, roda as verificações e faz commits locais. A implementação é delegada a executores mais leves em painéis laterais do herdr, na mesma aba da coordenação para Teodoro acompanhar, em paralelo quando as tarefas forem independentes. Detalhes em `AGENTS.md`, seção `Delegação e executores`.
- Toda decisão arquitetural vira um ADR em `docs/adr/`, numerado em sequência (o próximo é 0021) e listado em `docs/adr/README.md`, antes de a implementação correspondente começar. Outros documentos técnicos necessários ficam em `docs/`.
- O board do Whimsical [TreePM — Fluxos e processos (estilo BPMN)](https://whimsical.com/89u9ZSgv1LAMphWoQUFQny) registra todo fluxo, processo, evento ou ação visível novo ou alterado, em raias, com o estado (`IMPLEMENTADO`, `PROPOSTO` ou `VIGENTE`) e a fonte no título. No início de cada sessão, a sessão coordenadora (só ela; executores não acessam o board nem a rede para isso) lê os comentários do board; as decisões tomadas ali são refletidas em ADR, blueprint ou no próprio fluxo.
- Em 2026-11-19 Teodoro deu à sessão coordenadora autoridade de dona do repositório: commits, branches, push, PRs e comentários na issue #1 do GitHub (canal com a coordenação operacional, o grokbot) não dependem de nova autorização. Merge de PR que tenha aprovação como critério de aceite espera essa aprovação. Painel do Clerk, DNS, chaves e contratação de planos ficam com a coordenação operacional; segredos nunca entram no Git nem na issue, e `.env*` não é lido.
- A interface e a usabilidade atuais do mapa foram aprovadas por Teodoro em 2026-11-19 e são a referência. Não altere a interação existente sem pedido explícito; novas capacidades se somam a ela.
- A direção de produto (mapa espacial como mecânica central e tickets multidisciplinares) foi decidida por Teodoro em 2026-11-19. Não proponha protótipos ou etapas para validar essa tese; as dúvidas abertas da seção 15 do blueprint continuam abertas.
