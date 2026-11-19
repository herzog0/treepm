# Modelo de domínio e permissões — Fase 1 (organização segura)

**Estado:** proposta para implementação da Fase 1 do [blueprint](product-blueprint.md). Baseia-se nas ADRs [0019](adr/0019-clerk-organizacao-como-tenant.md), [0021](adr/0021-neon-postgres-e-rls-por-organizacao.md) e [0022](adr/0022-api-nestjs-e-hospedagem-na-fly.md). Contribuições por área e comentários são da Fase 2 e não aparecem aqui. O primeiro recorte de tickets (dados, permissões e API) está na [ADR 0024](adr/0024-tickets-primeiro-recorte-e-importacao-por-lista.md).

## Escopo

A Fase 1 entrega organização, pessoas, times, áreas, projetos e a política de acesso por projeto. A condição de saída é: casos negativos de acesso entre tenants e entre projetos passam; convite, revogação e troca de organização funcionam.

Convite, remoção e papel `admin`/`member` são feitos pelos componentes do Clerk; o TreePM só reflete o resultado.

## Entidades

Toda tabela abaixo tem `org_id text not null`, RLS forçado e chave primária composta `(org_id, id)`. IDs próprios são UUID v7 gerados pelo servidor. `created_at` e `updated_at` existem em todas.

| Tabela | Campos próprios | Regras |
| --- | --- | --- |
| `organizations` | `org_id` (ID da Clerk Organization, chave primária), `name`, `slug` | Uma linha por tenant, criada ou reconciliada no primeiro acesso autenticado. Nome e slug espelham o Clerk. |
| `people` | `id`, `clerk_user_id`, `display_name`, `email`, `avatar_url`, `clerk_role` (`admin` ou `member`), `active` | Uma linha por pessoa **por organização**; `(org_id, clerk_user_id)` é único. A mesma pessoa em duas organizações tem duas linhas sem ligação entre si. `active = false` quando a pessoa deixa a organização; a linha fica para preservar autoria. |
| `teams` | `id`, `name` | Nome único na organização. |
| `team_memberships` | `team_id`, `person_id`, `role` (`admin` ou `member`) | Uma linha por par. |
| `areas` | `id`, `name` | Disciplina (Engenharia, Design...). Nome único na organização. Não se confunde com time. |
| `projects` | `id`, `name`, `key` (prefixo dos tickets, ex.: `TREE`), `visibility` (`organization` ou `private`), `archived_at` | `key` único na organização. |
| `project_teams` | `project_id`, `team_id` | Associa times a projetos; não concede acesso por si só. |
| `project_memberships` | `project_id`, `person_id`, `role` (`manager`, `contributor` ou `reader`) | Uma linha por par. É a fonte do acesso a projeto. |
| `activity_events` | `id`, `actor_person_id`, `kind`, `subject_type`, `subject_id`, `payload jsonb`, `occurred_at` | Só inserção. Registra criação, alteração de papel, concessão e revogação de acesso. |

Chaves estrangeiras entre essas tabelas incluem `org_id`, de modo que o banco recusa ligar um time de uma organização a um projeto de outra.

## Papéis

| Origem | Papel | Significado |
| --- | --- | --- |
| Clerk | `admin` | Administrador da organização. |
| Clerk | `member` | Membro, sem acesso a projetos por padrão além dos de visibilidade `organization`. |
| Domínio, por time | `admin` | Gere o membership e os dados do próprio time. |
| Domínio, por projeto | `manager` | Gestor do projeto: estrutura, acesso e arquivamento. |
| Domínio, por projeto | `contributor` | Cria e edita trabalho no projeto (Fase 2). |
| Domínio, por projeto | `reader` | Só consulta. É também o papel de convidado. |

## Matriz de permissões da Fase 1

| Ação | Admin da organização | Admin do time | Gestor do projeto | Colaborador | Leitor | Membro sem papel |
| --- | --- | --- | --- | --- | --- | --- |
| Ver pessoas, times e áreas da organização | sim | sim | sim | sim | sim | sim |
| Criar, renomear e remover time | sim | renomear o seu | não | não | não | não |
| Incluir e remover pessoas de um time | sim | no seu time | não | não | não | não |
| Criar, renomear e remover área | sim | não | não | não | não | não |
| Criar projeto | sim | não | não | não | não | não |
| Ver projeto `organization` | sim | sim | sim | sim | sim | sim |
| Ver projeto `private` | sim | só com papel no projeto | sim | sim | sim | não |
| Renomear, mudar visibilidade e arquivar projeto | sim | não | sim | não | não | não |
| Conceder e revogar papel de projeto | sim | não | sim | não | não | não |
| Associar time a projeto | sim | não | sim | não | não | não |

Regras transversais:

- A autorização é decidida no servidor, em `packages/domain`, a partir do papel Clerk do token e das linhas de membership da transação atual. O RLS garante o tenant; ele não decide papel.
- Um projeto mantém ao menos um gestor ou depende do administrador da organização; revogar o último gestor é permitido porque o administrador sempre pode agir.
- Listagens e contagens aplicam a mesma regra de visibilidade: um membro sem papel não vê a existência de projetos privados.
- Toda mutação grava um `activity_event` na mesma transação.

## Superfície da API (prefixo `/api`)

| Método e caminho | Uso |
| --- | --- |
| `GET /me` | Pessoa atual, organização ativa e papéis; provisiona organização e pessoa se ainda não existirem. |
| `GET /people` | Pessoas da organização. |
| `GET/POST /teams`, `PATCH/DELETE /teams/:id` | Times. |
| `PUT/DELETE /teams/:id/members/:personId` | Membership de time. |
| `GET/POST /areas`, `PATCH/DELETE /areas/:id` | Áreas. |
| `GET/POST /projects`, `GET/PATCH /projects/:id` | Projetos, já filtrados pela visibilidade. |
| `PUT/DELETE /projects/:id/members/:personId` | Papel de projeto. |
| `PUT/DELETE /projects/:id/teams/:teamId` | Times do projeto. |

Erros: 401 sem sessão; 403 sem organização ativa ou sem permissão; 404 para recurso inexistente **ou** invisível ao chamador, para não revelar projetos privados.

## Leituras adotadas na implementação (2026-11-19)

Pontos que este documento não definia e que a API resolveu pela leitura mais restritiva. Valem até decisão em contrário.

- Alterar o papel de quem já é membro de um time segue a mesma regra de incluir e remover membros: administrador da organização ou administrador daquele time. Um administrador de time pode, portanto, promover outro membro do próprio time.
- Quem cria um projeto não vira gestor automaticamente. Só o administrador da organização cria projetos, e ele já tem acesso total.
- Projeto privado sem papel devolve 404 em qualquer rota, inclusive nas mutações. 403 só aparece para projeto visível sem permissão.
- `POST` devolve 201, `PUT` devolve 200 com corpo e é idempotente, `DELETE` devolve 204. Remover ou desassociar algo inexistente devolve 404.
- Pessoa inativa como alvo de membership devolve 409 (`person_inactive`). Conflitos de unicidade usam `team_name_taken`, `area_name_taken` e `project_key_taken`.
- A chave do projeto segue `^[A-Z][A-Z0-9]{1,9}$`. Corpos com campo desconhecido devolvem 400.
- Não há endpoint de contagem: lista e detalhe de projeto trazem membros e times já filtrados pela visibilidade.
- `people.active` só passa a `false` quando houver sincronização com o Clerk (webhooks, ADR futura). Até lá, quem sai da organização perde o acesso porque o token deixa de trazer a organização.

## Casos negativos obrigatórios

1. Com organização A no contexto, o papel `treepm_app` não lê, altera, remove nem insere linhas de B, em nenhuma tabela.
2. Sem contexto de organização, nenhuma tabela devolve linhas e nenhuma escrita passa.
3. Um ID de projeto de B enviado por um usuário de A devolve 404.
4. Membro sem papel não vê projeto privado em `GET /projects`, em `GET /projects/:id` nem em contagens.
5. Leitor e colaborador não conseguem conceder papéis nem alterar o projeto.
6. Pessoa removida da organização no Clerk não acessa mais nada, mesmo com linhas antigas de membership.
7. Uma relação entre time de A e projeto de B é recusada pelo banco.

## Fora da Fase 1

Tickets e árvore persistida (primeiro recorte na [ADR 0024](adr/0024-tickets-primeiro-recorte-e-importacao-por-lista.md)), comentários, convidados externos com escopo fino, administradores delegados além do time, webhooks do Clerk, exclusão definitiva e exportação.
