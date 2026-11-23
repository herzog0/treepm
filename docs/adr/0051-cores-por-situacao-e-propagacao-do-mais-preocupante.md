# ADR 0051 — Cores por situação: contrastantes, e o pai mostra o item mais preocupante

- **Data:** 2026-11-23
- **Estado:** aprovada por Teodoro em 2026-11-23 ("Pode implementar."), depois de ver a proposta [Cores por situação](https://claude.ai/artifact/Jb7zbXfDy21SZkXn1QunW4) (privada). Substitui, na [ADR 0025](0025-base-visual-constelacao-e-tema-do-mapa.md), a mistura de cores no ticket com filhos e os tons das situações. Implementação em `TREEPM-298`.

## Contexto

Pela ADR 0025, o ticket folha tem a cor da situação e o ticket com filhos é pintado com a mistura das cores das folhas descendentes. Teodoro, em 2026-11-23: "eu quero que as pessoas consigam identificar de longe o que está em progresso e o que não está. E com tons de verde relativamente parecidos, a pessoa não consegue identificar isso de cara, ainda mais se a pessoa tiver qualquer nível de daltonismo. Então, o ideal seria a gente ter cores bem discrepantes, contrastantes para os diferentes status. E aí, ao invés de a gente fazer um merge dessas cores, a gente propaga o item mais preocupante. [...] enquanto os filhos não forem verdes, o pai não pode ser verde".

A mistura produz tons intermediários que não correspondem a nenhuma situação, e que caem justamente entre as cores que mais se confundem.

## Decisão

### A paleta

| Situação | Cor | O que diz |
| --- | --- | --- |
| Bloqueado | `#ff5a4a` | depende de algo que ainda não acabou |
| Em andamento | `#3b8eff` | alguém está trabalhando agora |
| Em revisão | `#ffd000` | pronto, esperando alguém conferir |
| A fazer | `#70778a` | ninguém mexendo |
| Concluído | `#2ee6b6` | acabou |
| Cancelado | o cinza de "a fazer", apagado | não conta |

Cada situação tem matiz e brilho próprios. Sob simulação de protanopia, deuteranopia e tritanopia, nenhum par das cinco primeiras fica abaixo de 31 de distância (CIELAB); nos tons anteriores o pior par caía para 16. Os tons podem ser ajustados por Teodoro olhando o mapa de verdade, sem nova ADR, desde que a medida não piore.

Organização e projeto sem tickets continuam em lilás. A subárvore de ideia continua na cor de ideia ([ADR 0042](0042-ideias-na-arvore.md)); só o tom passa a `#f472d0`.

### "Bloqueado" é derivado, não é situação nova

Um ticket está bloqueado quando não está concluído nem cancelado e depende de outro ticket ainda aberto ([ADR 0037](0037-relacoes-entre-tickets-e-camada-de-consulta.md)); é o campo `blocked` que o resumo do ticket já traz (ADR 0047). O ticket bloqueado é pintado de vermelho, qualquer que seja a situação gravada. Nenhum campo novo, nenhuma mudança de banco ou de API.

### O pai propaga o mais preocupante

A cor de um ticket com filhos (e do projeto, e do quadrado que junta vários cards) é a da primeira situação desta lista que existir em qualquer descendente folha:

**bloqueado › em andamento › em revisão › a fazer › concluído**

- Bloqueado sobe até o topo: um único ticket bloqueado pinta todos os ancestrais, até o projeto, mesmo com outra coisa andando no ramo.
- O pai só é verde quando todos os descendentes que contam estão concluídos.
- Um ramo com trabalho pendente e nada ativo é cinza, mesmo com parte concluída; o progresso continua escrito no card.
- Cancelado e ideia não sobem. Um ramo só de cancelados fica no cinza apagado.

Nenhuma cor é misturada: todo nó do mapa tem exatamente uma das cores da paleta (ou lilás, ou a de ideia).

### O que não muda

Layout, cards, níveis de detalhe, zoom, gestos, marcador de situação (forma e texto) e o contorno de trabalho pela IA. A cor nunca é o único sinal: o marcador continua no card.

## Alternativas descartadas

- **Manter a mistura com tons mais separados.** O tom misturado continua não correspondendo a nenhuma situação.
- **"Bloqueado" como situação que a pessoa marca.** Pede campo, regra e histórico novos; a dependência aberta já existe e é verdadeira por construção. Impedimento marcado à mão (`TREEPM-95`) pode entrar na mesma cor depois.
- **Uma cor a mais para "começado e parado".** Mais uma cor enfraquece as outras.
- **Em revisão vencer em andamento.** O pedido é ver de longe o que está em progresso.

## Em aberto

1. Impedimento marcado pela pessoa entrar como bloqueado (`TREEPM-95`).
2. Sinal de forma, além da cor, no nível de ponto do mapa.

## Como ficou (PR #192, 2026-11-23)

- **Paleta numa fonte só:** `apps/web/src/map/situation.ts` e os tokens de `theme.css` (`--tp-blocked`, `--tp-doing`, `--tp-review`, `--tp-todo`, `--tp-done`, `--tp-cancelled`, `--tp-idea`); um teste trava cada token contra a constante. Mapa, marcador, página do ticket, importação e telas de MCP e GitHub usam os mesmos valores.
- **Regra:** `effectiveSituation` e `mostWorryingColor` em `situation.ts`; `paintBranches` continua de uma passagem só e pinta ticket com filhos, projeto e organização. O adaptador de mistura do pacote do mapa devolve a cor mais preocupante, nunca uma média. Um ticket com filhos que está ele mesmo bloqueado é vermelho e sobe vermelho.
- **Bloqueado por escrito:** "Bloqueado" no texto de estado do card e das listas e uma etiqueta na linha "Situação" da página do ticket, nos três idiomas. A situação gravada e o menu de situação não mudaram.
- **Legenda:** botão "Situações" no mapa, fechado por padrão, com as cinco situações na ordem de precedência.
- **Medida guardada em teste:** pior par entre as cinco situações em 35,8 (protanopia), 35,0 (deuteranopia) e 30,7 (tritanopia); o teste exige 30 ou mais. Cancelado e ideia descartada, que são escuros, passaram a usar texto claro.
- **Não mudou:** a base de layout de desktop não foi regravada.
- **Em aberto, para Teodoro ver no mapa de verdade:** os tons (`TREEPM-309`), o marcador de progresso do pai, que continua verde (`TREEPM-310`), projeto e organização inteiros na cor mais preocupante (`TREEPM-311`), e a cor verde do pai com texto de situação própria diferente (`TREEPM-312`).
