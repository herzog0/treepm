# ADR 0041 — Contribuições por área no ticket

**Status:** Proposta da coordenação em 2026-11-22, dentro da Fase 2 completa que Teodoro mandou seguir ("Pode seguir assim"). O objetivo vem do blueprint; o desenho abaixo é escolha da coordenação e vale até ele dizer o contrário. **Critérios de aceite e a regra de conclusão ficam fora**: são a pergunta aberta 3 do blueprint e só Teodoro responde. **Data:** 2026-11-22.

Segunda parte da Fase 2 completa (`TREEPM-36`): contribuições por área (`TREEPM-37`) e, em seguida, comentários por área (`TREEPM-91`), que a [ADR 0040](0040-atividade-do-ticket-historico-e-comentarios.md) deixou esperando por esta.

## Contexto

O blueprint define a contribuição de área como "seção do ticket com área, descrição, critérios de aceite, situação, impedimentos e pessoas assinaladas", e diz que "uma pessoa pode contribuir em mais de uma área", que não existe "dono único" e que "uma thread, checklist ou participação não vira automaticamente um segundo ticket nem conta duas vezes no progresso".

O que existe hoje, conferido no código em 2026-11-22:

- **Áreas** são uma lista de nomes da organização, criada e apagada pelo administrador. Nada no banco aponta para uma área: apagar uma não afeta nada.
- **Não existe ligação entre pessoa e área.** Quem pode mexer numa contribuição só pode ser decidido pelos papéis do projeto.
- O ticket tem uma descrição, uma lista de pessoas ("Pessoas", `ticket_assignees`) e uma situação.
- A pergunta aberta 3 do blueprint continua aberta: "Que critérios obrigam aceite de uma área e quem pode registrar uma exceção de conclusão?".

## Decisão

### O que é uma contribuição

Uma seção do ticket para uma área da organização. Cada ticket tem no máximo uma contribuição por área. A contribuição tem:

- a **área**;
- um **texto** em markdown, no mesmo subconjunto e com o mesmo editor da descrição (ADR 0036), de 0 a 20.000 caracteres;
- uma **situação própria**: `a fazer`, `em andamento` ou `pronta`;
- **pessoas**, quantas forem, escolhidas entre as pessoas da organização que enxergam o projeto.

Fora desta ADR: critérios de aceite, aceite, exceção de conclusão e impedimentos.

### O que não muda

- **A situação do ticket, a regra de concluir e a de reabrir.** A situação de uma contribuição é informativa: nenhuma contribuição impede concluir o ticket e nenhuma muda sozinha a situação dele. Tornar isso uma regra é a pergunta aberta 3.
- **O progresso.** Contribuições não contam em progresso nenhum.
- **A linha "Pessoas" e `ticket_assignees`.** As pessoas de uma contribuição se somam; ninguém é acrescentado nem tirado de "Pessoas" por causa de uma contribuição.
- **O mapa**, a árvore, a procura da IA e a lista de tickets.

### Regras

- **Quem mexe:** quem pode editar o ticket (gestor e colaborador do projeto) acrescenta uma contribuição, edita o texto, muda a situação e as pessoas, e remove a contribuição. Leitor lê. Projeto arquivado é só leitura. *(Escolha da coordenação: sem ligação entre pessoa e área, restringir "só quem é da área" não tem como ser conferido.)*
- **Remover uma contribuição** apaga o texto dela e as pessoas dela, com confirmação. O fato fica no histórico; o texto não.
- **Apagar uma área que tem contribuição é recusado** (409), com a contagem de tickets que a usam. Renomear a área continua livre e aparece em todas as contribuições. Uma área nunca leva texto embora ao ser apagada.
- **Chave de ticket no texto** vira a etiqueta clicável de sempre, mas **não grava ligação** em `ticket_relations`, pelo mesmo motivo dos comentários (ADR 0040): a ligação "menciona" é derivada só da descrição do ticket.
- **Ordem:** as contribuições aparecem na ordem em que foram criadas.

### Histórico

Eventos novos, no assunto ticket, que viram entradas na seção "Atividade": contribuição acrescentada, removida, texto editado, situação alterada, pessoa acrescentada e pessoa tirada. Todos dizem de qual área.

- O texto nunca entra no evento, como na descrição.
- Edições seguidas do texto da mesma contribuição pela mesma pessoa, em menos de 10 minutos, viram uma entrada só, pela mesma regra da descrição.
- O nome da área é resolvido na leitura; contribuição removida continua aparecendo pelo nome da área.

### Na página do ticket

Uma seção **"Áreas"**, entre a Descrição e os Itens.

- Cada contribuição é um bloco: o nome da área, a situação (menu com as três), as pessoas (com "Adicionar", como na linha "Pessoas") e o texto, lido e editado como a descrição, salvando sozinho.
- "Adicionar área" abre a lista das áreas da organização que o ticket ainda não tem. Sem nenhuma área cadastrada na organização, a seção diz isso e, para o administrador, aponta onde cadastrar.
- "Remover" fica no menu do bloco, com confirmação.
- Sem contribuição e sem poder editar, a seção não aparece.

### Fronteira com a IA e com o MCP

O texto das contribuições, a situação delas e as pessoas **não entram** na camada de consulta, nas ferramentas da pergunta sobre o projeto, na escrita da descrição, na conversa de novo ticket nem no servidor MCP. O teste que confere o teto do que sai ganha uma contribuição com texto reconhecível. Incluir depois é decisão de Teodoro: o texto de uma contribuição é texto de ticket, mas a autorização dele foi dada antes de as contribuições existirem.

### Banco (migration `0016`)

- `ticket_contributions`: organização, projeto, ticket, área, texto, situação, criada em e por quem. Única por ticket e área. Excluir o ticket exclui as contribuições; a referência à área impede apagá-la.
- `ticket_contribution_people`: contribuição e pessoa.
- Isolamento por organização e concessões mínimas, como nas tabelas recentes.

## Fatias

1. **Contribuições** (`TREEPM-37`): tabelas, rotas, eventos e entradas no histórico, a seção "Áreas". Migration `0016`.
2. **Comentários por área** (`TREEPM-91`): o comentário ganha uma referência opcional à contribuição; cada bloco de área mostra a conversa dela, e a seção "Atividade" continua mostrando tudo, dizendo de qual área é cada comentário. Migration `0017`.

Critérios de aceite e regra de conclusão (`TREEPM-38`) esperam a resposta de Teodoro à pergunta aberta 3.

## Alternativas descartadas

- **Um subticket por área.** É o que o blueprint quer evitar: duplica o contexto e conta duas vezes.
- **Só quem "é da área" edita a contribuição.** Não há ligação entre pessoa e área; criá-la é outra decisão, e o blueprint diz que área "não precisa coincidir com um time".
- **A situação da contribuição mexer na do ticket.** Seria responder à pergunta aberta 3 por conta própria.
- **Área como texto livre no ticket.** Perderia a lista única da organização, que os filtros e as visões por área vão usar.

## Em aberto

1. Pergunta aberta 3 do blueprint: o que obriga o aceite de uma área e quem registra exceção.
2. Se o texto das contribuições pode ir à IA e ao MCP.
3. Se as áreas aparecem no card do mapa (o blueprint as prevê nos níveis "compacto" e "completo").
4. Impedimentos por contribuição.

## Como ficou a fatia 1, contribuições (PR #131, 2026-11-22)

- **Banco:** `ticket_contributions` e `ticket_contribution_people` (migration `0016`). O papel da aplicação lê, insere e apaga nas duas, e só atualiza texto e situação da contribuição: não troca área, ticket, autoria nem data. A referência à área impede apagá-la.
- **Rotas:** `POST /api/tickets/:id/contributions`, `PATCH` e `DELETE /api/contributions/:id`, `PUT` e `DELETE /api/contributions/:id/people/:personId`. Área repetida no ticket: 409 `contribution_area_taken`. Quem pode ser pessoa de uma contribuição segue a mesma conferência dos responsáveis do ticket. `DELETE /api/areas/:id` com contribuição: 409 `area_in_use`, com a contagem de tickets.
- **Remover de novo** uma contribuição já removida responde 404, igual a uma que nunca existiu; só a corrida entre duas remoções responde 204 sem evento. O brief pedia idempotência; ficou assim porque a linha deixa de existir.
- **Leitura:** toda resposta de ticket do controlador traz `contributions` e `canEditContributions`. A lista, o resumo de ticket e o mapa não ganharam campo (há teste que compara as chaves). O detalhe faz no máximo duas consultas a mais, qualquer que seja o número de contribuições.
- **Eventos:** `ticket.contribution_added`, `_removed` (guarda o nome da área naquele momento), `_updated`, `_person_added` e `_person_removed`, nunca com o texto. A atividade ganhou seis tipos de entrada, e a junção de edições seguidas vale por contribuição.
- **O que não mudou, com teste:** concluir um ticket com contribuição `a fazer` continua permitido; mudar a situação de uma contribuição não muda a do ticket; o progresso do pai é o mesmo.
- **Fronteira:** nada da camada de consulta, do MCP ou do assistente foi alterado. As duas guardas foram provadas com um vazamento simulado, pela coordenação (para comentários) e pelo executor (para contribuições).
- **Web:** seção "Áreas" entre a Descrição e os Itens. O pedaço que o mapa baixa não cresceu; o da área autenticada cresceu cerca de 13 kB. Organização sem áreas: o administrador recebe um link para Configurações, que recarrega a página.
- **Não foi exercitado** com sessão real no navegador. Nenhum teste de navegador cobre marcar uma tarefa dentro do texto de uma área.
