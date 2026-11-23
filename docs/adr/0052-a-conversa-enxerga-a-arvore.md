# ADR 0052 — A conversa de novo ticket enxerga a árvore: ramo montado na hora, tickets relacionados e tarefas implicadas

- **Data:** 2026-11-23
- **Estado:** proposta da coordenação a pedido de Teodoro em 2026-11-23 ("Eu quero que você resolva tanto essa criação de ticket que foi falha agora [...] quanto a própria quebra em mais tickets depois do refinamento"); a forma do resumo (item 1) é ideia dele. Decisões de detalhe por delegação, reversíveis. Implementação em `TREEPM-326`.

## Contexto

Teodoro pediu pela conversa: "quero conseguir sincronizar os tickets daqui. não é apenas importação como temos em outro ticket já, mas também poder receber novas atualizações apenas do 'diff' [...] jira, github, linear, etc." O ticket (`TREEPM-319`) nasceu **na raiz**. O ticket de que ele falava, "Importar de GitHub, Jira e Linear" (`TREEPM-139`), estava dois níveis abaixo. E a quebra não percebeu que sincronizar depende de "guardar a origem de cada ticket" (`TREEPM-144`), que já existia. Ele notou os dois defeitos olhando o mapa.

O que a investigação e a medição mostraram (dados em `~/.local/share/treepm-ops/medicao-procura-319/`, fora do repositório):

1. **A procura só desce**, de cima para baixo ([ADR 0029](0029-novo-ticket-pela-conversa-com-a-ia.md), [0033](0033-descricao-antes-da-procura-e-texto-fixo-do-agrupador.md)). Em cada nível o Jev lê, de cada candidato, o título e um **resumo de ramo guardado** (`branch_summaries`).
2. **O resumo guardado nunca é refeito** (decisão da ADR 0033, para a escolha não oscilar). Mover tickets ou criar níveis não o atualiza. O de "Tickets no mapa" era de 2026-11-21 e só falava de importação por lista.
3. **Repetindo o pedido a seco:** raiz, sem incerteza (as treze raízes descartadas). Depois de regenerar os 67 resumos das folhas para o topo: três vezes em três, "Tickets no mapa" › "Importar, exportar e sincronizar". A medida não é limpa (o próprio `TREEPM-319` já estava na árvore e entrou no resumo novo), mas o resumo velho da raiz é a causa mais provável.
4. **No "depois" a procura propôs pôr o pedido dentro do `TREEPM-319`**, que é o mesmo pedido: nada confere se o ticket já existe.
5. **A quebra é cega para a árvore:** o Claude vê só os títulos das raízes ([ADR 0044](0044-conversa-quebra-o-pedido-em-pai-e-filhos.md)) e é proibido de acrescentar o que a pessoa não disse.
6. **Não dá para diagnosticar depois:** as probabilidades da procura não ficam guardadas.

## Decisão

### 1. O ramo é montado na hora; nada agregado fica guardado

Ideia de Teodoro: "esse resumo de cada ticket deveria estar associado diretamente a cada ticket [...] mover o ticket não muda nada".

- O que descreve um ticket é o que ele mesmo tem: o título e o começo da descrição.
- O que a procura mostra de um candidato é **montado na hora da procura**, da árvore como ela está: o título e o trecho do candidato, seguidos dos títulos dos descendentes, nível por nível (filhos primeiro), até um limite de tamanho. Ideias descartadas e tickets cancelados não entram.
- A procura **deixa de escrever** em `branch_summaries` e deixa de chamar o Claude para resumir ramo. Mover, criar e remover não exigem atualizar nada.
- O texto escrito por uma pessoa para um ramo (a edição que a tela de resumo já permite) continua existindo como nota do ticket e entra na montagem, antes dos descendentes. Os textos escritos pelo assistente deixam de ser lidos.
- **Condição para ficar:** medido com a ferramenta de procura (tirar e recolocar tickets), o acerto com o ramo montado não pode ser pior que o de hoje com resumos recém-regenerados. Se for pior, a montagem muda (mais descendentes, trechos) antes de entrar.

### 2. Antes de quebrar e de procurar, a conversa acha os tickets relacionados

- **Busca de baixo para cima**, em qualquer nível: primeiro uma triagem por palavras do pedido que pontua por termos em comum (sem exigir todos), sobre título e trecho; depois um julgamento do Jev por candidato ("o trabalho de `draft` trata do mesmo assunto que este ticket?"). Sem vetores nem provedor novo (isso é `TREEPM-127`).
- Os mais prováveis (limiar 0,7, no máximo oito) são os **tickets relacionados** do pedido. Eles servem a três coisas, abaixo.

### 3. O lugar: os relacionados concorrem com a descida

- O pai de cada ticket relacionado entra como caminho candidato na procura, ao lado dos caminhos da descida.
- **Muda o desempate da raiz.** Hoje "ficar na raiz" vence toda a faixa de dúvida (regra R0 da ADR 0033, que ficou em aberto para Teodoro). Passa a valer: havendo ticket relacionado acima do limiar, o caminho dele vence "ficar na raiz". Sem relacionado, nada muda. É mudança de regra, não ajuste silencioso de limiar.
- **Pedido que já existe:** se um relacionado é o mesmo pedido (julgamento próprio do Jev, limiar alto), a conversa avisa "já existe: TREEPM-N" e oferece abrir o que existe, antes de criar. Nunca propõe criar o ticket dentro do próprio duplicado.

### 4. A quebra enxerga os relacionados e elabora o que o pedido implica

A regra da ADR 0044 continua: o texto da pessoa fica citado, inteiro, e nada que ela não disse entra **como se ela tivesse dito**. Somam-se duas coisas, sempre separadas do que é dela:

- **Ligação com o que já existe.** O Claude recebe a lista curta dos relacionados (chave, título, trecho) e pode propor "depende de" entre o ticket novo (ou uma parte) e um ticket existente. Tarefa implicada que já existe vira **ligação**, nunca ticket repetido.
- **Tarefa implicada que não existe.** O Claude pode propor partes que o pedido implica e a pessoa não disse (um pré-requisito, um passo sem o qual o resto não funciona), cada uma com uma frase dizendo por que é necessária. Elas aparecem na prévia num grupo próprio, "Sugeridas pelo assistente", **já incluídas e removíveis uma a uma** ("deveria estar incluso", nas palavras de Teodoro). No ticket criado, a descrição diz que a parte foi sugerida pelo assistente, não pedida.
- Limite de cinco sugestões por pedido. Sem relacionados e sem implicação clara, a quebra sai como hoje.

### 5. A decisão da procura fica guardada

Com a conversa ficam os números da decisão: por nível, a probabilidade de "cabe em algum" e a de cada candidato, o caminho escolhido e os relacionados com as suas probabilidades. Só identificadores e números, sem texto. O ticket criado pela conversa guarda a referência. Pede migration (`0028`).

### Dados enviados aos provedores

Nada de categoria nova: títulos e trechos de descrição de tickets do projeto já vão ao Claude e ao Jev (ADR 0029, aceite da organização na [ADR 0039](0039-termos-privacidade-e-aceite-por-organizacao.md)). Muda a quantidade: o Claude passa a receber até oito tickets relacionados. Continuam fora nomes de pessoas, comentários, histórico e texto das áreas. Revisão independente de privacidade antes do merge de cada fatia.

## Fatias (uma depois da outra: mexem nos mesmos arquivos)

1. Ramo montado na hora e decisão guardada (API, migration `0028`).
2. Tickets relacionados, lugar e aviso de duplicado (API e tela).
3. Quebra com ligações e tarefas sugeridas (API e tela).

## Como se confere

- **O caso de Teodoro vira caso fixo de medição**, com a árvore exportada: passa se o pedido cai dentro de "Importar, exportar e sincronizar tickets" e se a ligação com "guardar a origem" é proposta.
- A medição da conversa passa a contar "sugeridas pelo assistente" à parte de "inventadas": sugestão marcada não é invenção; afirmação posta na boca da pessoa continua sendo.
- Tirar e recolocar tickets não piora.

## Alternativas descartadas

- **Só regenerar os resumos quando a árvore muda.** Resolve o caso, mas reabre a oscilação que a ADR 0033 mediu e custa uma chamada ao Claude por ancestral a cada movimento.
- **Mandar o projeto inteiro ao Claude.** Descartado por Teodoro por custo (ADR 0033).
- **Só mudar o limiar da raiz.** Põe mais tickets em ramo errado; a medição da ADR 0033 mostrou que os limiares são pontos da mesma curva.
- **Tarefa implicada criada sem marca.** Quebra a garantia de que o que está no ticket como pedido foi pedido.

## Em aberto

1. Busca semântica por vetores (`TREEPM-127`).
2. Sugerir "depende de" também ao editar um ticket que já existe.
3. O que fazer com a tabela `branch_summaries` e a tela de resumo depois que os textos do assistente saírem de uso.

## Como ficou (PRs #194, #196 a #201, 2026-11-23)

**Ramo montado na hora (PR #196, migration `0028`).** `apps/api/src/assistant/branch-text.ts` monta o texto de cada candidato: trecho do próprio ticket, nota escrita por pessoa, "Contém:" (filhos diretos), "Dentro deles:" (netos) e "Mais abaixo:", com teto de 1 100 caracteres; se o nível não cabe na pergunta, os descendentes de todos encolhem na mesma proporção. A procura não lê nem escreve mais resumo escrito pelo assistente. A subárvore de um ticket cancelado saiu da árvore da procura, como a das ideias. As rotas de resumo continuam: `GET` devolve o texto montado (`source: "built"`) ou a nota da pessoa; regenerar não tem efeito.

**Decisão guardada (migrations `0028` e `0029`).** Tabela `placement_decisions`: por nível, a probabilidade de "cabe em algum" e a de cada candidato, o caminho, as alternativas, os relacionados com as duas probabilidades e a regra que decidiu. Só identificadores e números. Guardar nunca impede a procura nem a criação do ticket.

**Tickets relacionados e lugar (PR #197).** Triagem por palavras em `packages/domain/src/related.ts` (radical de 5 letras, peso que zera termo presente em quase todos os tickets, até 30) e duas perguntas ao Jev por candidato: mesmo assunto (relacionado a partir de 0,7, até 8) e mesmo pedido (duplicado a partir de 0,85, saído de qualquer candidato julgado). Regra do lugar (`related-placement.ts`), decidida pelo relacionado elegível mais provável:

| Situação | Resultado |
| --- | --- |
| sem relacionado elegível | o destino da descida, como antes |
| o pai do relacionado é o destino ou está acima dele | fica o destino da descida (a escolha nunca sobe) |
| a descida parou na raiz | o pai do relacionado vence; sem aviso de incerteza só com probabilidade de 0,85 ou mais |
| a descida parou num nível intermediário, ancestral do pai do relacionado | o pai do relacionado só vence com 0,85 ou mais; abaixo disso fica onde a descida parou, com o outro como alternativa |
| ramos diferentes | pergunta de escolha ao Jev entre os destinos; o resultado sai marcado como incerto |

O destino nunca sai do escopo que a pessoa escolheu. O pior caso de tempo da rota ficou igual ao de antes (50 s). Na tela: lista "Relacionados" e o aviso "Já existe um ticket que parece ser este pedido", com a situação dele, que bloqueia criar até a pessoa escolher; abrir um ticket não fecha o assistente.

**Elaboração (PRs #198, #199, #200 e #201).** Rota `POST /ticket-conversations/:id/elaboration`, chamada pela tela depois da procura. Primeira chamada ao Claude: rascunho e até oito relacionados (chave, título, trecho, situação); devolve ligações "depende de" e tarefas sugeridas. Segunda chamada, só quando há sugeridas: cada sugerida com os dez tickets mais parecidos da árvore, e o modelo diz qual já a entrega; havendo, a sugerida vira ligação. O servidor descarta chave fora da lista, o duplicado, o destino e os ancestrais dele, repetidas, texto que imite a citação do pedido, e o que passa dos limites (5 e 5; descrição de sugerida até 600 caracteres). A resposta traz `diagnostics`, só com números. Na prévia: "Sugeridas pelo assistente" (já incluídas, removíveis, com a descrição à vista) e "Ligações propostas" (marcadas); o botão de criar espera a elaboração, com "Criar sem esperar"; elaboração feita para um rascunho que mudou não é enviada. Na criação: as sugeridas viram filhos depois das partes da pessoa, com a descrição começando por "Sugerida pelo assistente, não pedida:", e as dependências nascem na mesma transação; o servidor revalida tudo e informa o que descartou. Ordem das travas: consultivas do projeto (estrutura, depois dependências), linhas de ticket, linha do projeto por último. O prompt de sistema da conversa não mudou.

**Ferramenta.** `conversation-dry-run`, `case-run` (caso fixo sobre uma árvore exportada, com repetições), dependência e resumo pela linha de comando, importação da árvore em partes.

### O que foi medido com os provedores de verdade

Arquivos em `~/.local/share/treepm-ops/medicao-0052/` e `medicao-conversa/`, fora do repositório.

- **O caso que originou a ADR** (árvore exportada sem o `TREEPM-319`): antes, raiz. Depois, o lugar certo em todas as repetições de todas as rodadas (3, 3, 3, 6 e 6).
- **A ligação com o pré-requisito que já existia (`TREEPM-144`)**, em seis repetições: com o julgamento do Jev, 1 de 6 (e o modelo calado em 3); com a segunda chamada ao Claude e o prompt menos calado, 4 de 6, e o modelo propôs em todas. Nas 2 restantes a tarefa ficou como sugerida: o modelo a escreveu mais ampla do que o ticket existente cobre.
- **Medição da conversa** (13 casos, 2 rodadas): 11 passam em tudo; nenhum detalhe perdido, nenhum trecho inventado; os dois casos em que nada é implicado vieram vazios nas duas rodadas. Os dois que não passam: o caso da tarefa que já existe (1 de 2, o mesmo resíduo acima) e um caso que esperava exatamente uma sugerida e recebeu duas, ambas pré-requisitos razoáveis (a expectativa do caso é que estava estreita).
- **Tirar e recolocar 40 tickets**, uma rodada por versão: 31 no ramo certo no código anterior (base inflada: o resumo do pai tinha sido escrito com o ticket testado dentro), 28 com o ramo montado na hora, 26 com os relacionados. As três cabem na oscilação que a ADR 0033 já tinha medido entre cópias iguais (28 a 33 de 39); uma rodada não distingue melhora de piora. **A condição do item 1 ("não pior") não pôde ser afirmada nem negada.** A medição precisa de repetição e de amostra sorteada (`TREEPM-338`).

### O que continua em aberto

- Ticket cujo pai tem poucos filhos e pouca descrição ainda vai para a raiz (`TREEPM-339`); inclui a regra da faixa de dúvida no primeiro nível, que é de Teodoro.
- A tarefa sugerida que cobre mais do que o ticket existente ainda aparece como tarefa nova em parte das vezes.
- Nada disso foi usado por Teodoro com sessão real.
