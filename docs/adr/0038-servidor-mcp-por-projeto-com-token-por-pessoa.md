# ADR 0038 — Servidor MCP por projeto, com token por pessoa

**Status:** Aceita por Teodoro em 2026-11-21 quanto ao objetivo ("Mcp com token por pessoa tbm"). O desenho abaixo é escolha da coordenação e vale até ele dizer o contrário. A fatia dos tokens foi implementada em 2026-11-21 (PR #113, migration `0012_access_tokens`); o endereço MCP e as telas em 2026-11-22 (PRs #118 e #117). Não foi exercitado com um cliente MCP de verdade nem com o Clerk real. O código depende da camada de consulta da [ADR 0037](0037-relacoes-entre-tickets-e-camada-de-consulta.md) (`TREEPM-77`). **Data:** 2026-11-21.

## Contexto

Teodoro quer usar a base de cada projeto "quase que como um servidor mcp", para que a IA que a pessoa já usa (Claude Code, Cursor, Codex) consulte os tickets diretamente. A ADR 0037 criou a camada de consulta só de leitura e deixou o servidor MCP para uma ADR própria, porque ele exige a primeira entrada que não passa pela sessão do navegador.

O que foi conferido na documentação em 2026-11-21 (não é conhecimento de memória):

- **Protocolo.** A revisão atual da especificação é a de 2026-07-28. O transporte remoto é o Streamable HTTP: um endereço que aceita `POST`, uma mensagem por requisição, e a resposta pode ser JSON simples. Sessão, canal `GET` e a troca inicial `initialize` foram removidos nessa revisão; clientes mais antigos ainda usam a troca inicial, e um servidor pode atender às duas gerações. ([transporte](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [versões](https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning))
- **Autorização.** É opcional na especificação. O caminho descrito nela é OAuth 2.1; um token fixo no cabeçalho `Authorization` é permitido, mas fica fora desse caminho. ([autorização](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization))
- **Clientes.** Claude Code, Cursor e Codex aceitam um servidor remoto com cabeçalho fixo na configuração. Os conectores personalizados do claude.ai pedem OAuth quando cada pessoa entra com a própria conta; o cabeçalho fixo deles é para credencial compartilhada e está em beta restrito. ([Claude Code](https://code.claude.com/docs/en/mcp), [Cursor](https://cursor.com/docs/context/mcp), [Codex](https://developers.openai.com/codex/mcp), [conectores](https://claude.com/docs/connectors/custom/remote-mcp))
- **Biblioteca.** O SDK oficial em TypeScript tem a versão 2 (`@modelcontextprotocol/server`, licença Apache 2.0), que serve sem sessão, responde em JSON e atende também os clientes da geração anterior. ([SDK](https://ts.sdk.modelcontextprotocol.io/v2))

O que existe hoje na API e pesa aqui:

- Toda requisição entra por uma sessão do Clerk, que traz a organização; o isolamento por organização no banco depende disso.
- A API fica sabendo que uma pessoa saiu da organização só pela sessão dela, que deixa de valer. A sincronização de pessoas por webhook (`TREEPM-4`) não foi feita.

## Decisão

### O que o servidor oferece

- **Um endereço por projeto:** `POST /api/mcp/<chave do projeto>`. As ferramentas não recebem projeto: o endereço já diz qual é.
- **Só leitura.** As ferramentas são as quatro operações da camada de consulta (buscar, ler ticket, listar, resumo do projeto), marcadas como somente leitura. Nenhuma ferramenta altera dados.
- **O que devolve:** título, descrição, situação, chave real do ticket, pai, filhos e ligações. **Não devolve dado de pessoa** (responsáveis, autor) nem histórico nesta primeira versão.
- **Tamanho:** as listas têm o teto da camada de consulta e dizem quando foram cortadas; o resultado de uma ferramenta é cortado em 80.000 caracteres de JSON, perto do limite padrão de 25.000 tokens do Claude Code. *(A primeira redação falava em tokens; a implementação mede caracteres.)*

Aqui o limite da ADR 0037 para a Anthropic não se aplica por si: o cliente é da própria pessoa e pode usar qualquer modelo. Por isso há a chave da organização, abaixo.

### Quem liga

- **Chave por organização, desligada por padrão:** "Permitir acesso por MCP". Só um administrador da organização liga. Desligar corta todos os tokens da organização na requisição seguinte, sem apagá-los.
- Com a chave ligada, qualquer pessoa cria tokens para os projetos que enxerga.

### O token

- **De uma pessoa, para um projeto.** Um token vazado expõe um projeto, não a organização.
- **Formato:** prefixo `tpm_`, a referência da organização e um segredo aleatório de 256 bits. A referência da organização permite achar o token respeitando o isolamento do banco, sem função que o contorne; uma referência forjada só faz o token não ser encontrado.
- **Guardado:** só o resumo SHA-256 do token e os primeiros caracteres, para a pessoa reconhecê-lo na lista. O token inteiro aparece **uma vez**, na criação.
- **Validade obrigatória:** 30, 90 ou 365 dias, com 90 como padrão.
- **Revogação:** pela própria pessoa, a qualquer momento, e por um administrador da organização.
- **Limite:** 10 tokens ativos por pessoa em cada organização.

### Como a requisição é autorizada

- O token resolve para a mesma identidade que uma sessão: pessoa, organização e papéis lidos do banco a cada requisição. A permissão sobre o projeto passa pela mesma conferência das rotas de hoje.
- Falha na requisição seguinte: token revogado ou vencido, chave da organização desligada, pessoa inativa, pessoa sem acesso ao projeto, projeto removido.
- **Projeto arquivado continua podendo ser lido,** como na web, e pode receber token novo. *(Corrigido em 2026-11-21: a primeira redação desta ADR o punha entre as falhas.)*
- **Papéis:** os de projeto e de time são lidos do banco a cada requisição. O papel da pessoa na organização vem do Clerk e pode ter até 5 minutos de atraso, pela mesma memória da saída da organização.
- **Saída da organização.** Quem sai da organização no Clerk precisa perder o token em até 5 minutos, e os tokens dela são revogados nesse momento: voltar à organização não os faz valer de novo. Como a API hoje só percebe isso pela sessão, a entrada por token confirma a participação no Clerk, com memória de no máximo 5 minutos, até a sincronização por webhook (`TREEPM-4`) existir. Sem uma das duas, o servidor MCP não vai para produção.
- **Respostas:** 401 para token ausente, inválido, vencido ou revogado, sem dizer qual; 404 para projeto que a pessoa não enxerga, como nas outras rotas; 403 com a chave da organização desligada; 400 para requisição malformada.
- Requisição com cabeçalho `Origin` de outro site é recusada (403), como a especificação exige; os clientes de terminal e editor não enviam esse cabeçalho.
- **Limite de requisições** por token, 60 por minuto. Antes da autenticação, o endereço tem também um limite por endereço IP, para que tokens inventados não ocupem o banco.

### Higiene

- O token nunca aparece em log, evento, resposta de listagem nem endereço. O log leva só o identificador do registro.
- Criar e revogar gravam evento de atividade, sem o segredo.
- "Último uso" é atualizado no máximo uma vez a cada 5 minutos por token.

### Transporte e biblioteca

- Streamable HTTP sem sessão, resposta em JSON, atendendo à revisão de 2026-07-28 e aos clientes da geração anterior.
- SDK oficial em TypeScript, versão 2, montado na API que já existe. Antes de escrever código, o executor confere os nomes e as assinaturas no pacote instalado e na documentação atual, e para se algo não se confirmar.
- **Autenticação por cabeçalho fixo** (`Authorization: Bearer`). Atende Claude Code, Cursor e Codex. Não atende os conectores do claude.ai, que pedem OAuth.

### Na interface

- No projeto, "Conectar um cliente de IA": criar token (nome e validade), ver o token uma vez com o trecho de configuração pronto para Claude Code, Cursor e Codex, e a lista dos próprios tokens (nome, começo, criação, último uso, validade) com "Revogar".
- Nas configurações da organização: a chave "Permitir acesso por MCP" e a lista de todos os tokens da organização, com "Revogar".
- Textos nos três idiomas (ADR 0035).

### Banco (migration `0012`)

- Tabela `access_tokens`: organização, pessoa, projeto, nome, começo do token, resumo (único), validade, revogação, último uso; isolamento por organização como as outras tabelas; remover a pessoa ou o projeto remove os tokens.
- Coluna `mcp_enabled` na organização, falsa por padrão.

## Fatias

1. **Tokens:** migration, criar, listar e revogar, a chave da organização e as telas. Não depende da camada de consulta.
2. **Servidor MCP:** o endereço, a autorização por token e as quatro ferramentas. Depois de `TREEPM-77`.

As duas ficam no `TREEPM-78`, com um filho por fatia quando começarem.

## Alternativas descartadas

- **OAuth 2.1 agora.** É o caminho da especificação e o único que serve aos conectores do claude.ai, mas exige servidor de autorização, registro de clientes e telas de consentimento. O token fixo atende os três clientes de terminal e editor, que são o uso pedido.
- **Um endereço só, com o projeto como parâmetro das ferramentas.** Configura uma vez para todos os projetos, mas o token valeria para tudo o que a pessoa enxerga.
- **Token que vale para a organização inteira.** Mesmo motivo.
- **Função no banco que acha o token contornando o isolamento.** Abriria a primeira exceção ao isolamento por organização.

## Em aberto

1. OAuth, para os conectores do claude.ai.
2. Devolver responsáveis e histórico, e com qual controle.
3. Ferramentas de escrita (criar ticket, mudar situação).
4. Branches e pull requests ligados ao ticket.
5. Se o limite de requisições precisa valer entre várias máquinas (hoje a publicação prevê uma).

## Como ficou na implementação (fatia 1, tokens)

- **Formato:** `tpm_`, a organização em base64url e 32 bytes aleatórios. O token inteiro tem no máximo 256 caracteres, e a organização precisa ter o formato dos identificadores do Clerk; fora disso é recusado antes de qualquer consulta ao banco.
- **Rotas, com sessão normal:** `PATCH /api/organization` (a chave, só administrador), `POST`, `GET` e `DELETE` em `/api/access-tokens`, e `GET /api/access-tokens/organization` (só administrador). O `GET /api/me` informa `mcp.enabled`.
- **Limite de 10 ativos** por pessoa, serializado no banco: 14 criações simultâneas dão exatamente 10.
- **Resolver** (`AccessTokenService.resolve`), ainda sem rota: devolve a mesma identidade de uma sessão ou uma de quatro falhas (`invalid`, `disabled`, `not_found`, `rate_limited`). Erro do Clerk ou do banco sobe como erro, nunca vira "válido".
- **Participação no Clerk:** uma consulta por pessoa por vez, guardada por 5 minutos só quando positiva, e conferida contra a pessoa pedida.
- **Depois do Clerk,** o token, a chave da organização e a pessoa são relidos antes do sucesso.
- **Saiu da organização:** a pessoa fica inativa e os tokens ativos dela são revogados, com evento automático.
- A montagem da identidade virou um serviço comum à sessão e ao token; o caminho da sessão passou a ler `mcp_enabled`, e por isso a migration precisa estar aplicada antes do código.
- Uma revisão de segurança independente não achou falha grave; o que ela apontou entrou antes do merge, menos o limite por IP antes da autenticação, que é da fatia do endereço.
- Suítes: domain 243, db 200, api 1.442. O Clerk não foi chamado de verdade.

## Como ficou na implementação (fatia 2, endereço e telas)

**O endereço (PR #118)**

- `POST /api/mcp/<chave do projeto>`, montado antes do leitor de corpo da API e fora da guarda de sessão. `GET` e `DELETE` respondem 405.
- **Biblioteca:** `@modelcontextprotocol/server` 2.4.0, conferida no pacote instalado e na especificação de 2026-07-28. Atende a revisão atual em JSON e os clientes da geração anterior, cuja resposta sai como fluxo de uma mensagem só.
- **Ferramentas:** `search_tickets`, `get_ticket`, `list_tickets` e `get_project_overview`, com nomes e descrições em inglês e marcadas como somente leitura. Devolvem a chave real; um teste varre todas as respostas atrás de id, pessoa e data.
- **Ordem de cada requisição:** limite por IP; caminho e método; `Origin`; corpo de até 64 KB; só objeto JSON; recusa de fluxos abertos; token; ferramenta.
- **Erro de ferramenta:** a mensagem do SDK é trocada por uma frase curta, por um ponto de extensão que não é público na biblioteca. A versão é fixada, e um teste falha se a troca deixar de valer.

**O que a revisão de segurança mudou**

Uma revisão independente reproduziu dois defeitos contra o código real, corrigidos antes do merge:

- **Lote:** um corpo com 100 mensagens passava por uma única conta do limite por token. Agora só objeto JSON é aceito.
- **Fluxo aberto:** um corpo com BOM contornava a recusa e deixava uma conexão pendurada. O corpo passou a ser interpretado uma vez só, e toda requisição tem prazo de 30 segundos com cancelamento.
- **IP atrás do proxy:** sem ajuste, todos os clientes dividiriam um limite só. O IP vem de um cabeçalho configurável (`CLIENT_IP_HEADER`), com IPv6 agrupado por /64. A documentação da Fly não diz que o proxy sobrescreve `Fly-Client-IP`; `docs/deploy.md` tem a conferência a fazer depois do primeiro deploy.
- **Proteção que não depende do IP:** no máximo quatro consultas de token ao mesmo tempo, com fila de 16.
- **Log:** só o id do registro do token, o método, a ferramenta, o tempo e o tamanho; texto vindo do cliente é limpo de caracteres de controle, e erros internos entram só pela classe.

**As telas (PR #117)**

- Ficaram em **Configurações**, na seção "Clientes de IA (MCP)", e não na página de cada projeto como esta ADR previa: a chave da organização, os próprios tokens e os da organização ficam juntos.
- O token novo aparece uma vez, com a configuração pronta para Claude Code, Cursor e Codex, e some ao fechar o painel.
- Na lista, o token aparece por um trecho de 8 caracteres do meio dele.

**Memória.** Com o banco em uso, o processo fica perto de 200 MiB; a máquina de produção passou de 256 para 512 MB.

Suítes: domain 243, db 200, api 1.524, web 1.430 e 85 na suíte de navegador.

## Atualização (2026-11-26): limites por minuto

A pedido de Teodoro (`TREEPM-558`), os quatro tetos por minuto do servidor MCP passam a 5.000: requisições por IP (era 120), requisições por token (era 60), escritas por token (era 20) e escritas por pessoa (era 40). Janela e mecanismo não mudam. Os valores ficam em `apps/api/src/mcp/mcp-limits.ts` e `access-token.service.ts`, e as descrições das ferramentas leem as constantes.
