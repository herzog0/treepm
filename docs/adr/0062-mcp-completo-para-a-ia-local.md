# 0062 — MCP completo: a IA local de cada pessoa trabalha os tickets como a tela trabalha

- **Data:** 2026-11-25
- **Situação:** pedido de Teodoro em 2026-11-25 (`TREEPM-420`): "amplia o mcp antes de tudo então, quero tudo isso que vc citou". O "tudo isso" é a lista do que o servidor MCP ainda não fazia: editar título e descrição, mover ticket na árvore, mexer em responsáveis e relações, ler comentários, histórico e conversas, e a importação do Linear. O desenho é da coordenação, por delegação. Altera as ADRs [0038](0038-servidor-mcp-por-projeto-com-token-por-pessoa.md) e [0043](0043-agentes-nos-tickets-mcp-com-escrita-e-marcador.md).

## Contexto

Teodoro quer trabalhar os tickets pela IA dele (Claude Code), gastando a assinatura e não chave de API. Em 2026-11-24 descartou um aplicativo de mesa e escolheu ampliar o MCP. Hoje o servidor tem cinco leituras (`search_tickets`, `get_ticket`, `list_tickets`, `get_work_queue`, `get_project_overview`) e cinco escritas (`create_ticket`, `update_ticket_status`, `set_ticket_priority`, `add_comment`, `set_agent_work`), com token por pessoa e por projeto e duas chaves da organização, leitura e escrita, desligadas por padrão.

Até aqui o MCP nunca entregou dado de pessoa: nem nome, nem responsável, nem comentário, nem conversa. Foi regra de Teodoro, repetida em várias ADRs. O pedido de agora inclui responsáveis, comentários e conversas, e isso não se entrega sem nome de gente. Teodoro confirmou em 2026-11-25, perguntado com essas palavras: "confirmo, pode sair nomes e mensagens pelo mcp".

## Decisão

### 1. Um terceiro alcance: pessoas e conversas

- O token e a organização ganham um terceiro alcance, **pessoas e conversas**, ao lado de leitura e escrita. Como os outros, nasce desligado: um administrador liga na organização, e quem cria o token escolhe se o inclui.
- Sem ele, o MCP continua exatamente como hoje: nenhum nome, nenhum comentário, nenhuma conversa. Uma organização que ligou a leitura quando ela não trazia dado de pessoa não passa a entregar esse dado sem decidir de novo.
- Com ele, as leituras passam a trazer nomes e as ferramentas das seções 3 e 4 aparecem. Identificador interno de pessoa sai só onde é preciso para escrever (definir responsável); e-mail nunca sai.

### 2. Escritas de ticket (alcance de escrita, sem dado novo)

| Ferramenta | O que faz |
| --- | --- |
| `update_ticket` | Muda título e descrição. A descrição segue as regras da tela: recusa menção de pessoa, respeita os limites, refaz as menções de ticket. |
| `move_ticket` | Pedido expresso de Teodoro ("quero que o mcp possa mudar o pai de um ticket, ou seja, mover ele pela árvore"). Muda o pai (outro ticket do mesmo projeto, ou a raiz). Mesmas regras de estrutura da tela: sem ciclo, reabertura do ancestral concluído, regras de ideia. |
| `add_dependency`, `remove_dependency` | Cria e remove "depende de" entre dois tickets do projeto, com a recusa de ciclo que a tela tem. |

Mover entre projetos fica fora: o token é de um projeto.

### 3. Pessoas e responsáveis (alcance de pessoas; escrever pede também o de escrita)

- `list_people`: as pessoas que a dona do token enxerga no projeto, com nome e identificador.
- `get_ticket`, `list_tickets` e `search_tickets` passam a trazer os responsáveis pelo nome.
- `set_ticket_assignees`: define os responsáveis de um ticket, pelas regras da tela.

### 4. Comentários, histórico e conversas (alcance de pessoas; só leitura)

- `list_comments`: comentários de um ticket, com autor, data e texto. Comentário removido não aparece.
- `get_ticket_history`: a linha do tempo do ticket, como a página mostra.
- `list_conversations` e `get_conversation`: só as conversas **do projeto do token** de que a dona do token participa (os chats de ticket dela, o chat geral do projeto, threads em que está). As mensagens vêm com autor, inclusive as de outras pessoas. Nunca conversa de outra pessoa, nem de outro projeto.
- O Meu chat não pertence a um projeto e enxerga todos os da pessoa; o token é de um projeto só. Por isso o Meu chat fica fora (seção "Em aberto").
- O histórico é filtrado antes de sair: o login da conta do GitHub, o identificador de token e o administrador real de um "entrar como" não aparecem.
- Menções de pessoa no texto saem como nome simples, sem o identificador.
- Escrever em conversa pelo MCP fica fora deste recorte.

### 5. Linear (alcance de leitura para ver; de escrita para sincronizar)

- `get_ticket` passa a trazer a origem do ticket: chave e endereço no Linear.
- `get_linear_status`: se o projeto está ligado a um time e quando foi a última sincronização.
- `start_linear_sync` e `continue_linear_sync`: abrem a rodada da [ADR 0061](0061-sincronizar-com-o-linear.md) e executam **um passo por chamada**; o cliente chama de novo até acabar. Usam a chave do Linear da própria dona do token, com as mesmas permissões da tela. A chave nunca aparece na resposta. Cada passo conta no limite de escritas por minuto.
- A origem no Linear (chave e endereço da issue) passa a sair para o cliente da pessoa; a Política de privacidade diz isso.
- A procura do lugar (categorização) não entra: ela usa os provedores de IA do TreePM e continua só na tela.

### 6. O que não muda

- Toda escrita passa pelo mesmo serviço e pelas mesmas regras da tela, em nome da dona do token, com a autoria "pelo MCP" no histórico, o limite de 20 escritas por minuto e a conferência, a cada escrita, de que a pessoa ainda está na organização.
- Nenhum texto de ticket, comentário ou conversa entra em log.
- Cada fatia passa por uma revisão de segurança independente antes do `main`, como as anteriores.
- Os Termos e a Política de privacidade, publicados em 2026-11-25, dizem o que o token faz e o que sai pelo MCP. Mudam na mesma mudança de cada fatia. Não é envio a provedor de IA do TreePM, então a versão do aceite de IA não muda.

## Fatias

1. **Editar, mover e relações** (`TREEPM-493`).
2. **Pessoas e responsáveis**, com o terceiro alcance: banco, tela de tokens e chave da organização (`TREEPM-494`).
3. **Comentários, histórico e conversas** (`TREEPM-495`).
4. **Linear** (`TREEPM-496`); a sincronização depende da fatia 1 da ADR 0061.

## Em aberto

- O Meu chat pelo MCP: pede um token que não seja de um projeto só, ou uma regra de recorte por projeto dentro dele.

## Alternativas descartadas

- **Pôr nomes e conversas dentro do alcance de leitura.** Mais simples, mas muda calado o que uma organização autorizou quando ligou a leitura.
- **Um alcance por tipo de dado** (comentários, conversas, pessoas separados). Três chaves a mais para uma decisão que na prática é uma só: deixar ou não sair dado de gente.
- **Sincronização inteira numa chamada só.** Uma rodada pode levar minutos e a máquina de produção para sem tráfego; o passo curto é o que já funciona.

## Fora deste recorte

- Escrever em conversas, arquivar tickets, mexer em áreas e contribuições, mover entre projetos, criar projeto.
- A categorização pela IA do TreePM via MCP.

## Consequências

- Com o terceiro alcance ligado, nomes, comentários e mensagens de outras pessoas saem do TreePM para o cliente de IA de quem tem o token e para o provedor desse cliente. O TreePM não controla o que eles fazem com isso; a tela de tokens e os documentos legais dizem isso com clareza.
- O MCP passa a ser uma segunda porta para quase tudo o que a tela faz com tickets. A regra de sempre vale mais ainda: nenhuma ferramenta tem regra própria, todas chamam o serviço da tela.

## Como ficou (fatia 1, 2026-11-25)

- Ferramentas novas, todas de escrita: `update_ticket`, `move_ticket`, `add_dependency`, `remove_dependency`. Devolvem o ticket no formato de `get_ticket`.
- As regras de dependência saíram do controlador HTTP para o serviço; editar e mover já usavam o serviço da tela. `move_ticket` espera na mesma fila de estrutura e pega a mesma trava que a tela.
- A regra "limite de profundidade" não existe ao mover pela tela (só na importação), então o MCP também não a aplica: a ADR dizia o contrário.
- Estrutura ocupada responde "tente de novo em instantes" também no MCP. O erro genérico das escritas diz que nada foi alterado. Título, descrição e comentário recusam o caractere nulo nas duas portas (antes dava erro 500).
- Tokens de escrita já emitidos ganham as quatro ferramentas sem novo aceite; os Termos e a tela de tokens dizem o que o alcance faz.
- Revisão de segurança independente, com reprodução: sem bloqueio. Ficou a `TREEPM-499` (grafias exóticas de menção de pessoa que escapam da recusa, nas duas portas).

## Como ficou (fatia 2, 2026-11-25)

- Migration `0042_mcp_people_scope`: `organizations.mcp_people_enabled` e `access_tokens.people`, os dois falsos por padrão. O alcance do token é uma coluna própria, independente de leitura e escrita, e a aplicação não consegue alterá-la depois de criado o token.
- O alcance efetivo é conferido a cada chamada: token com pessoas e chave da organização ligada. Desligar a chave corta os nomes na chamada seguinte.
- `list_people` devolve quem pode ser responsável no projeto (`id`, `name`, `me`). `get_ticket`, `list_tickets`, `search_tickets` e `get_work_queue` ganham `assignees`; sem o alcance a chave nem existe. `set_ticket_assignees` exige escrita e pessoas.
- **Todo nome de pessoa sai por uma função só** (`mcp/person-name.ts`). Quem não tem nome no Clerk tem o e-mail ou o identificador do Clerk como nome de exibição; nesses casos sai "Unnamed person". Um teste falha se o nome for lido no MCP por outro caminho. Achado da revisão de segurança, que bloqueou a fatia até a correção.
- Definir responsáveis trava a linha do ticket, na tela e no MCP: duas definições simultâneas terminam em uma das duas listas. Identificador de pessoa em maiúsculas é normalizado nas duas portas.
- Limites conhecidos: a memória de até 5 minutos da participação no Clerk (ADR 0038) vale também para a leitura de nomes; a escrita não a usa. Um responsável que saiu da organização continua aparecendo pelo nome no ticket, como na tela. Pessoas de teste aparecem em `list_people`, como na tela.
- Em projeto privado, quem só tem acesso por um time ligado ao projeto não pode ser responsável nem aparece em `list_people`; é a regra da tela, e a dúvida foi levada a Teodoro.

## Como ficou (fatia 3, 2026-11-25)

- Quatro leituras, só com o alcance de pessoas: `list_comments`, `get_ticket_history`, `list_conversations`, `get_conversation`. Paginadas por cursor, com teto de 80.000 caracteres por resposta; item maior que o teto sai cortado com `truncated: true`.
- Conversas: só as do projeto do token de que a pessoa participa, pela mesma regra da barra lateral, inclusive as fechadas. O recorte olha também a conversa de origem, porque uma thread do Meu chat que cita um ticket ganha o projeto no banco. Recusa idêntica para conversa inexistente, alheia, de outro projeto ou do Meu chat.
- Thread de criação de ticket: saem o título e o estado, não a descrição do rascunho. Resumos gerados por IA não saem.
- Histórico: sai por lista do que pode sair, por tipo de evento; tipo desconhecido sai só com o tipo e a data.
- Todo texto que sai passa por um limpador (menção de pessoa vira `@Nome`, sem identificador) ou tem formato fechado, e isso é garantido por tipo. Nome de pessoa com forma de menção também vira "Unnamed person".
- Ler pelo MCP não marca nada como lido nem reabre conversa.
- A revisão de segurança achou expressões de busca de custo quadrático na limpeza de menções (uma chamada de 4,9 s de processador com texto hostil). Foram reescritas em tempo linear, no MCP e no domínio, o que também protege a tela ao salvar descrição e mensagem.

## Como ficou (fatia 4, 2026-11-25)

- `get_ticket` traz `linear: { key, url }` para ticket importado; as listas não. `get_linear_status` diz se o projeto está ligado, a chave e o nome do time, a última sincronização e, para quem pode importar, a rodada aberta.
- `start_linear_sync` e `continue_linear_sync` são escritas e chamam o mesmo serviço da tela, com a chave do Linear de quem tem o token. Um passo por chamada, dentro do prazo do MCP; a resposta diz o que fazer em seguida. Sincronizar pelo MCP dá o mesmo resultado que pela tela (teste de paridade).
- A primeira importação de um projeto continua só na tela; a procura do lugar pela IA não é exposta.
- **Texto vindo do Linear não sai cru para o cliente de IA.** Quem lê a resposta é um modelo, e um nome ou endereço malicioso seria uma instrução injetada. Nenhuma frase de erro leva texto do Linear; o endereço só sai com host exato `linear.app` e sem espaço nem controle; a chave só no formato de identificador; o nome do time passa pelo limpador comum, cortado em 80. A mesma validação de endereço e de identificador vale na gravação, para a tela.
- A checagem de permissão do passo vem antes da trava de "passo em andamento", na tela e no MCP.
- Revisão de segurança independente com reprodução: sem bloqueio; sete correções aplicadas. Fica a `TREEPM-510` (prazo próprio para a abertura da sincronização).

## Acréscimo com o histórico do Linear (ADR 0061, fatia 4, 2026-11-25)

- `get_ticket_history` passa a trazer o histórico importado do Linear e a entrada "criou a issue no Linear", só com o alcance de pessoas. Com isso saem por ali, para quem tem esse alcance, o nome de quem criou a issue no Linear e o de quem fez cada mudança: a pessoa do TreePM correspondente ou o nome de exibição de lá, sempre pelo limpador de nomes. Nenhum identificador do Linear sai, e nomes de coluna e títulos antigos passam pelo limpador de texto.
- A seção 5 dizia que as leituras do MCP não conheciam os dados de origem além da chave e do endereço da issue; para o criador e o histórico, deixou de valer dentro do alcance de pessoas. Sem o alcance, nada mudou.
