# ADR 0054 — Na dúvida sobre o lugar do ticket, a conversa pergunta

- **Data:** 2026-11-23
- **Estado:** decisão de Teodoro em 2026-11-23 ("a gente aceita que possa haver ambiguidade, e a gente deixa uma margem grande de ambiguidade [...] maior do que o usual, talvez. E aí tudo que tiver nessa faixa de ambiguidade a gente responde com a pergunta, tentando se aprofundar até o nosso nível de ambiguidade ser baixíssimo. Ou melhor, dentro do restante da faixa [...] que a gente aceitou."). O detalhe abaixo é da coordenação, por delegação, e é reversível. Resolve `TREEPM-339`.

## Contexto

A procura do lugar ([ADR 0029](0029-novo-ticket-pela-conversa-com-a-ia.md), [0033](0033-descricao-antes-da-procura-e-texto-fixo-do-agrupador.md), [0052](0052-a-conversa-enxerga-a-arvore.md)) desce a árvore perguntando ao Jev, em cada nível, se o pedido cabe em algum ramo e em qual. A [ADR 0053](0053-busca-por-significado-com-vetores-por-ticket.md) acrescentou vizinhos por significado à lista de candidatos. Medido com os provedores de verdade, isso não mudou o resultado.

O motivo, nas palavras de Teodoro: semelhança de termos ou de sentido supõe que o assunto muda devagar de um nível para o outro, e nem sempre muda. Um ticket pode estar dentro de outro por um motivo que nenhum dos dois textos diz ("remover bucket do S3" com um filho "modificar storage de campo de nome"). Estar contido é "faz parte do trabalho para aquilo acontecer"; parecer é "fala do mesmo assunto". A procura só enxerga a segunda relação, e nesses casos só a pessoa sabe onde o ticket fica.

Dois fatos do código de hoje:

- Quando o Jev responde, no primeiro nível, que o pedido não cabe em ramo nenhum com probabilidade abaixo de 0,3, o ticket vai para a raiz **sem aviso de incerteza**. Foi assim que o `TREEPM-319` nasceu na raiz.
- Na faixa de 0,3 a 0,7 a tela avisa que não tem certeza, mas já propõe um destino, e a pessoa pode criar sem escolher.

### Calibração com o que já estava guardado

Oitenta colocações das medições de tirar e recolocar tickets (ADR 0052), olhando só os passos do caminho escolhido. "Erra calado" é colocar em outro ramo sem avisar.

| Regra | Pergunta ou avisa | Erra calado |
|---|---|---|
| Hoje (faixa 0,3 a 0,7, aviso sem bloquear) | 41% | 15% |
| Faixa 0,2 a 0,8 e escolha abaixo de 0,5 | 60% | 11% |
| Faixa 0,15 a 0,85 e escolha abaixo de 0,5 | 68% | 8% |
| Faixa 0,1 a 0,9 | 76% | 6% |
| Faixa 0,05 a 0,95 | 96% | 3% |

Leitura: a confiança do Jev separa mal o certo do errado. Alargar a faixa troca erros calados por perguntas quase um para um, e cinco erros têm confiança alta em todos os níveis (nenhuma faixa os pega; parte deles pode ser lugar igualmente válido, porque o gabarito é só uma das árvores possíveis). Quem perguntaria, perguntaria em média 1,2 a 1,6 vez por ticket. A medição é dura de propósito (ticket sem contexto nenhum de onde a pessoa estava); o uso real tem mais sinal.

## Decisão

### 1. O que conta como dúvida

Em qualquer passo do caminho que a procura manteve:

- **Cabe em algum?** A probabilidade de "cabe em algum ramo daqui" está dentro da faixa de dúvida.
- **Em qual?** A procura desceria, havia mais de um candidato, e o escolhido não se destaca.
- **Raiz:** no primeiro nível, a procura concluiria que não cabe em ramo nenhum. A raiz só é destino sem pergunta quando a pessoa escolheu deixar o ticket solto.
- **Conflito com relacionados:** os relacionados apontam para outro ramo e a escolha não foi confiante, ou não pôde ser feita.
- **Procura interrompida:** nível grande demais, limite de níveis, falha ou prazo do Jev.

A faixa e o limiar da escolha são configuração, não constante espalhada. Valores de partida: faixa de 0,2 a 0,8 e escolha abaixo de 0,5. **Não são critério de aceite:** a largura é de Teodoro, que a calibra pela curva medida (item 6).

### 2. Na dúvida, a conversa pergunta e não propõe destino

- A pergunta é feita no **nível mais raso em dúvida** do caminho, porque um erro em cima invalida tudo o que vem abaixo.
- Ela é montada em código, não pelo modelo: "Onde isto entra?", com até três ramos candidatos daquele nível (título e caminho na árvore, em ordem de probabilidade), mais "fica aqui mesmo, em ‹nó atual›" (na raiz: "deixar solto no projeto") e "nenhum destes: escolher no mapa". Nenhuma opção vem marcada.
- Enquanto a pergunta está aberta, a prévia não tem destino e **o botão de criar fica desligado**. O prompt de sistema da conversa não muda e nada novo vai a provedor.
- A pessoa também pode responder escrevendo na conversa. Isso é um turno normal: o rascunho pode mudar e a procura roda de novo. Não há intérprete novo para texto livre nesta decisão.

### 3. A resposta vale

- Escolher um ramo faz a procura **continuar a partir dele**. A escolha não é julgada de novo: não passa pela conferência de "fora do escopo" e os relacionados não podem tirar o ticket de dentro do ramo respondido (dentro dele, continuam valendo).
- "Fica aqui" e "deixar solto" encerram: o destino é aquele, sem aviso de incerteza.
- "Escolher no mapa" usa o que já existe; o lugar apontado pela pessoa é final.

### 4. Aprofundar até a dúvida caber

- Depois de cada resposta a procura segue descendo. Se houver dúvida em outro nível, nova pergunta, do mesmo jeito.
- **Teto de três perguntas por ticket.** No teto, o destino é o nível mais fundo já confirmado pela pessoa; a tela diz que dá para criar ali ou escolher mais fundo no mapa, e o botão de criar volta.
- Sem dúvida em nenhum passo, vale o de hoje: destino proposto, alternativas visíveis, criar com um toque.

### 5. Ferramentas sem pessoa

`case-run`, tirar e recolocar, `measure:conversation` e `conversation-dry-run` não podem travar na pergunta nem medir o comportamento antigo. Elas ganham um respondedor pelo gabarito: quando a procura perguntaria, registram que perguntaria, o nível, se o lugar certo estava entre as opções e qual era o palpite; respondem com o ramo certo quando ele está nas opções, e com "nenhum destes" quando não está.

### 6. Como medir

Sem limiar fixado de antemão. A ferramenta de tirar e recolocar passa a relatar, para um conjunto de larguras de faixa numa mesma rodada (os julgamentos são os mesmos; só a regra muda):

- quantos tickets teriam pergunta, e quantas perguntas por ticket;
- em quantas perguntas o lugar certo estava entre as opções;
- quantos tickets iriam para o ramo errado sem pergunta;
- o resultado final com o respondedor pelo gabarito.

A curva vai a Teodoro, que escolhe a largura. A decisão guardada da procura registra, só com identificadores e números, cada pergunta feita (nível, opções, tipo da resposta).

## Fora deste recorte

- Usar o contexto da pessoa como sinal do lugar (de onde ela abriu a conversa, no que está trabalhando): proposta em `TREEPM-358`. É o que tem mais chance de baixar o número de perguntas.
- Guardar o porquê quando a pessoa coloca um ticket onde o texto não explica: `TREEPM-359`.
- Interpretar resposta em texto livre como escolha de opção.
- Melhorar o lugar com mais semelhança de texto. Semelhança continua servindo para duplicado, ligações sugeridas e busca.

## Consequências

- A conversa passa a perguntar em bem mais casos do que hoje avisa. Com os valores de partida, na medição dura, em cerca de seis de cada dez tickets, com pouco mais de uma pergunta cada.
- Nenhum ticket vai para a raiz sem a pessoa ter dito isso.
- Mesmo com faixa larga sobram erros confiantes; a pessoa continua vendo o destino e podendo trocá-lo antes de criar.
- A regra da [ADR 0033](0033-descricao-antes-da-procura-e-texto-fixo-do-agrupador.md) de que a raiz vence a faixa do meio deixa de valer.
