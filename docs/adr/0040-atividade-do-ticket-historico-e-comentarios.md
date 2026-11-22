# ADR 0040 — Atividade do ticket: histórico visível e comentários

**Status:** Proposta da coordenação em 2026-11-22, depois de Teodoro mandar seguir com a Fase 2 completa começando por comentários e histórico ("Pode seguir assim"). O objetivo vem do blueprint; o desenho abaixo é escolha da coordenação e vale até ele dizer o contrário. **Data:** 2026-11-22.

Abre a Fase 2 completa do blueprint (`TREEPM-36`): histórico (`TREEPM-40`) e comentários (`TREEPM-39`). Contribuições por área (`TREEPM-37`) e critérios de aceite (`TREEPM-38`) pedem ADR própria, depois desta.

## Contexto

A [ADR 0036](0036-barra-de-pedidos-e-pagina-do-ticket-em-blocos.md) deixou comentários e histórico fora, "que são da Fase 2 completa". O blueprint pede as duas coisas: "Comentário / thread: conversa com escopo explícito global ou de contribuição de área; mantém autoria e histórico" e "Evento de atividade: mudança atribuída a uma pessoa […]; permite auditoria e notificações". Diz também que "remoção de acesso não apaga autoria histórica".

O que existe hoje, conferido no código em 2026-11-22:

- Toda alteração de ticket já grava uma linha em `activity_events`, na mesma transação, com quem fez e quando. O papel do banco usado pela API só pode ler e inserir nessa tabela: ela é só de acréscimo.
- O que cada evento guarda:

  | Evento | Guarda |
  | --- | --- |
  | `ticket.created` | chave, título, id do pai, situação, ids dos responsáveis |
  | `ticket.updated` | os campos alterados; para título, situação e pai, o valor de antes e o de depois; para a descrição, **só o fato de que mudou** |
  | `ticket.updated` com `automatic` | reabertura automática do pai, com a chave do ticket que a causou |
  | `ticket.assignee_added` / `_removed` | id da pessoa |
  | `ticket.dependency_added` / `_removed` | chave e id do outro ticket |
  | `ticket.summary_updated` | origem do texto (pessoa ou IA) |

- Tickets importados por lista não têm `ticket.created`: a importação grava um evento só, no projeto.
- A tabela não tem índice por assunto: ler os eventos de um ticket hoje percorre todos os da organização.
- Uma pessoa nunca é apagada: fica com `active = false`. A autoria continua resolvendo para um nome.
- Não existe comentário em lugar nenhum.

## Decisão

### Uma seção só: "Atividade"

No fim da página do ticket, depois de Itens e de Código, uma seção "Atividade" mostra em ordem de tempo, do mais antigo para o mais novo, as mudanças do ticket e os comentários, misturados. O campo de escrever comentário fica no fim. *(Escolha da coordenação: é o desenho que Linear e GitHub usam, e evita duas listas que a pessoa precisa cruzar de cabeça.)*

- Mostra as 30 entradas mais recentes; "Mostrar anteriores" busca as seguintes.
- Quem vê o ticket vê a atividade inteira dele. Não há atividade privada.

### Histórico

**Fonte:** só os eventos de `activity_events` cujo assunto é este ticket. Nada é gravado a mais nesta fatia, e eventos antigos não são reescritos.

**A API devolve entradas já resolvidas**, não o evento cru. Um `ticket.updated` com três campos vira três entradas. Tipos de entrada:

| Entrada | Mostra |
| --- | --- |
| criado | quem criou |
| título alterado | o título de antes e o de depois |
| descrição editada | só o fato; o texto antigo não foi guardado e não é mostrado |
| situação alterada | de qual para qual; quando foi reabertura automática, diz isso e por causa de qual ticket |
| pai alterado | o ticket de antes e o de depois (chave e título de hoje), ou "sem pai" |
| responsável adicionado / removido | o nome da pessoa |
| dependência adicionada / removida | a chave e o título do outro ticket |
| resumo do ramo atualizado | se foi por pessoa ou pela IA |

Regras:

- **Ids são resolvidos na leitura.** Ticket que não existe mais aparece como "ticket removido" (com a chave, quando o evento a guardou). Pessoa inativa aparece pelo nome, como qualquer outra.
- **Ticket sem evento de criação** (importado, ou anterior aos eventos): a primeira entrada é montada a partir do próprio ticket, com quem o criou e a data de criação.
- **Edições seguidas da descrição** pela mesma pessoa, com menos de 10 minutos entre uma e outra, viram uma entrada só, com a hora da última. A descrição salva sozinha enquanto a pessoa digita, e sem isso a lista viraria ruído.
- **Tipo de evento que a leitura não conhece é ignorado**, sem erro: eventos novos podem ser gravados antes de a tela saber mostrá-los.
- Cada entrada traz quem fez (nome e imagem, os mesmos dados que a tela de responsáveis já mostra) e quando.

**Banco:** índice em `activity_events (org_id, subject_type, subject_id, occurred_at)`. Migration `0014`.

**Rota:** `GET tickets/:id/activity`, paginada por cursor, da mais recente para a mais antiga (a tela inverte). Só leitura; não grava evento.

### Comentários

**Escopo:** só o comentário global do ticket. Comentário por área depende de a contribuição de área existir (`TREEPM-37`); quando existir, o comentário ganha uma referência opcional à contribuição, sem mudar os comentários já feitos.

**Tabela `ticket_comments`** (migration `0015`): organização, projeto, ticket, autor, corpo, criado em, editado em, removido em. Isolamento por organização como as outras tabelas.

- **Corpo:** markdown no mesmo subconjunto da descrição (ADR 0036), de 1 a 10.000 caracteres. É lido com o mesmo componente da descrição e escrito com o mesmo editor, sem o item "Pedir ao assistente para escrever".
- **Chave de ticket no comentário** vira a mesma etiqueta clicável da descrição, mas **não grava ligação** em `ticket_relations`: a ligação "menciona" é derivada só da descrição (ADR 0037), e a reconciliação dela apagaria qualquer ligação vinda de outro lugar. "Mencionado em" continua falando só de descrições.
- **Quem comenta:** quem pode editar o ticket (gestor e colaborador do projeto). Leitor lê. Projeto arquivado não recebe comentário novo. *(Escolha da coordenação: hoje o leitor não escreve nada no projeto, e comentar é escrever.)*
- **Editar:** só o autor. O comentário editado mostra "editado"; a versão anterior não é guardada.
- **Remover:** o autor, ou um gestor do projeto. O corpo é apagado do banco na hora e a entrada fica na lista como "comentário removido", com quem escreveu e quando, para a conversa em volta não perder o sentido.
- **Autoria sobrevive:** a referência ao autor impede apagar a pessoa (como nos eventos), e pessoa inativa continua aparecendo pelo nome. Excluir o ticket exclui os comentários dele.
- **Eventos:** comentar, editar e remover gravam evento de atividade com o id do comentário e **sem o corpo**. Um comentário removido não pode sobreviver dentro do histórico. Esses eventos não viram entradas próprias na lista: o comentário já é a entrada.

**Rotas:** `POST tickets/:id/comments`, `PATCH comments/:id`, `DELETE comments/:id`. A leitura vem na mesma rota da atividade, que passa a intercalar comentários e mudanças.

### Fronteira com a IA e com o MCP

Comentários e histórico **não entram** na camada de consulta (ADR 0037), nas ferramentas da pergunta sobre o projeto, na escrita da descrição, na conversa de novo ticket nem no servidor MCP (ADR 0038).

- A autorização de Teodoro para enviar dados à Anthropic e à TypeSafe cobre texto de tickets e de conversas com o assistente. Comentário é texto escrito por pessoas umas para as outras, e histórico é dado sobre pessoas (quem fez o quê e quando).
- O teste que confere o teto do que sai para o provedor ganha um comentário reconhecível na semente, para falhar se um dia vazar.
- Incluir comentários na IA ou no MCP depois é decisão de Teodoro, não desta ADR.

### Fora deste recorte

- Comentário por área, threads com respostas, reações, anexos e citação de critério.
- Menção a pessoas e qualquer notificação.
- Versões da descrição (o blueprint pede; hoje o texto antigo não é guardado, e guardar passa a ser decisão própria, com custo de armazenamento e de privacidade).
- Histórico do projeto, da organização ou de um ticket já excluído.
- Política de retenção e anonimização, que o blueprint põe "antes do piloto com dados reais".

## Fatias

1. **Histórico** (`TREEPM-40`): índice, rota de leitura e a seção "Atividade" só com mudanças. Migration `0014`.
2. **Comentários** (`TREEPM-39`): tabela, rotas, intercalação na mesma seção e o editor no fim. Migration `0015`.

Uma depois da outra, porque mexem na mesma rota e na mesma seção da página. A migration `0013` é do aceite por organização ([ADR 0039](0039-termos-privacidade-e-aceite-por-organizacao.md)), que corre em paralelo.

## Alternativas descartadas

- **Duas abas, "Comentários" e "Histórico".** Separa o que a pessoa lê junto ("mudou para em revisão" logo antes de "pode revisar?") e gasta um clique para ver metade da conversa.
- **Devolver o evento cru e resolver na web.** A web teria de buscar tickets e pessoas por id, inclusive os que não existem mais, e cada cliente novo repetiria a regra.
- **Guardar o corpo do comentário no evento de atividade.** A tabela de eventos é só de acréscimo: o texto removido ficaria lá para sempre.
- **Comentário gravar ligação "menciona".** Quebraria a regra de que essa ligação é derivada de um texto só e pode ser reconstruída a qualquer hora.
- **Leitor comenta.** Possível, mas cria a primeira escrita de leitor no projeto; fica como pergunta para Teodoro.

## Em aberto

1. Leitor pode comentar?
2. Comentários e histórico podem ser lidos pela IA e pelo MCP?
3. Guardar versões da descrição.
4. Retenção: por quanto tempo eventos e comentários removidos deixam rastro.
