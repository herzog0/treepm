# ADR 0048 — Modo play: modelos de filtro e navegação de ticket em ticket

- **Data:** 2026-11-23
- **Estado:** decisão da coordenação, por delegação de Teodoro em 2026-11-23; reversível. Implementação em `TREEPM-235`.

## Contexto

Pedido de Teodoro em 2026-11-22: "implementar uma função de botão 'play', ao clicar abre drop-down com algumas opções de template, que são basicamente filtros de tasks e o modo play (ao selecionar) navega de task em task do filtro, com botão de avançar no topo (ou retroceder) caso a pessoa queira ir pra próxima task ou anterior. Modo standup é uma das sub opções do botão play."

O mapa já leva a câmera, animada, até um ticket (ADR 0026) e abre a página dele com um clique. Falta um jeito de percorrer um conjunto de tickets em sequência: revisar o que é meu, conduzir a reunião diária, ver o que os agentes estão fazendo.

## Decisão

### O botão

Um botão **play** no cabeçalho, ao lado da barra de pedidos, visível em qualquer largura. Abre um menu com os modelos. Escolher um modelo começa o modo play. O menu diz, ao lado de cada modelo, quantos tickets ele tem agora; modelo vazio aparece desabilitado.

### Os modelos (vêm prontos; a pessoa ainda não cria os dela)

Cada modelo é um filtro e uma ordem sobre os tickets do alcance.

| Modelo | O que traz | Ordem |
| --- | --- | --- |
| **Próximos para trabalhar** | a fila da ADR 0047 | a da fila |
| **Meu trabalho** | os meus tickets em andamento e a fazer, fora de ideias | em andamento primeiro; depois prioridade que vale; depois a árvore |
| **Em andamento** | tudo o que está em andamento no alcance | por pessoa responsável, depois a árvore |
| **Stand-up** | por pessoa: o que ela tem em andamento e o próximo dela na fila | pessoas em ordem alfabética, quem conduz por último; dentro de cada uma, em andamento e depois o próximo |
| **Trabalho pela IA** | tickets com o marcador de trabalho pela IA ligado | os que vencem antes primeiro |

O **alcance** é o ramo selecionado no mapa (projeto ou ticket) quando o play começa; sem seleção, tudo o que a pessoa enxerga. O alcance aparece na barra do play.

O stand-up desta ADR é o roteiro por pessoa. Participantes escolhidos, roteiro por área ou por subárvore, tempo de fala e o registro do que foi dito continuam no modo stand-up completo (`TREEPM-117`), que passa a ser a evolução deste modelo, não uma tela à parte.

### O modo play

- Uma **barra do play** aparece no topo, no lugar da barra de pedidos enquanto o modo dura: o nome do modelo, a posição ("3 de 12"), **voltar** e **avançar**, e **sair**. No stand-up mostra também a pessoa da vez ("Ana · 2 de 3").
- Em cada passo a **câmera vai até o ticket**, com a animação que já existe, e **a página dele abre**, como num clique. Avançar troca a página, sem fechar e abrir.
- **Teclado:** seta para a direita ou `J` avança, seta para a esquerda ou `K` volta, `Esc` sai (com a página aberta, o primeiro `Esc` continua fechando a página, como hoje, e o segundo sai do play). As setas não agem enquanto a pessoa digita num campo.
- **Celular:** os mesmos botões, com alvo de 44 px; sem gesto novo, para não disputar com o arraste do mapa.
- **Fim da lista:** avançar fica desabilitado e a barra oferece "Recomeçar". No começo, voltar fica desabilitado.
- **A lista é fotografada no começo.** Se um ticket deixa de caber no modelo durante o play (alguém o concluiu), ele continua na sequência, para a posição não pular sob os pés de quem conduz; a página mostra a situação atual. "Recomeçar" refaz a lista.
- **Nada é gravado:** o play é só navegação. Sair devolve a barra de pedidos e deixa a câmera onde está (ADR 0028).
- O estado do play vive na sessão da pessoa; recarregar a página sai do modo.

### Onde fica a regra

Os modelos são funções puras do domínio (`packages/domain`), sobre os resumos de ticket que o mapa já tem: sem rota nova e sem ida ao servidor por passo. Nada disso passa por IA.

## Alternativas descartadas

- **Só a câmera, sem abrir a página.** Mantém o mapa à vista, mas o que se discute numa reunião é o conteúdo do ticket; a página é a que um clique abriria.
- **Uma tela de lista separada do mapa.** Mais simples, mas joga fora o que o produto tem de próprio: ver onde cada ticket está.
- **Modelos criados pela pessoa já agora.** É a ideia de filtros e visões salvas (`TREEPM-133`), ainda não aceita; os modelos prontos mostram primeiro se o modo serve.
- **Avançar marcando o ticket como visto ou concluído.** Mistura navegar com mudar dado.

## Em aberto

1. Modelos criados pela pessoa, pelo projeto ou pela organização (`TREEPM-133`).
2. Stand-up completo: participantes, roteiros por área e por subárvore, tempo de fala (`TREEPM-117`).
3. "Concluídos desde a última reunião", que pede a data da mudança de situação no resumo do ticket.
4. Link que abre o play num modelo e numa posição.

## Como ficou (PRs #172 e #174, 2026-11-23)

- **Regras (PR #172):** os cinco modelos são funções puras em `packages/domain/src/play.ts` (`playTemplates`, `playTemplate`).
- **Tela (PR #174, `apps/web/src/play/`):** o botão play fica **dentro do campo da barra de pedidos**, à direita, e não ao lado dela: assim nenhum elemento do cabeçalho muda de lugar (o campo de texto ficou 40 px mais estreito). O menu mostra a contagem de cada modelo e desabilita o vazio. A barra do play toma o lugar da barra de pedidos, com posição, voltar, avançar, sair e, no fim, "Recomeçar"; no stand-up mostra a pessoa da vez.
- **Tela estreita:** abaixo de 1000 px a página do ticket ocupa a tela e cobria a barra do play. A barra passou a ficar no pé da tela, por cima da página, e a página ganhou folga embaixo. Achado olhando as capturas; tem teste em 360, 390, 430 e 800 px.
- **Câmera:** o teste de navegador confere que a câmera chega no ticket de cada passo.
- **Conferência:** suíte de navegador rodada (254 testes) e capturas olhadas pela coordenação. Não foi usado por Teodoro com sessão real.
