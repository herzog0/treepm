# 0066 — Sincronizar deixando o Linear vencer

- **Data:** 2026-11-26
- **Situação:** pedido de Teodoro em 2026-11-26, com alta prioridade: "uma opção no import do linear que quando importar pode, tipo assim, limpar a base de tickets e reimportar do zero completamente. Isso vai ser útil quando os dois saírem de sincronia e eu quiser puxar novas descrições, puxar novos status". Perguntado se queria apagar os tickets ou sobrescrever os campos sem apagar nada, escolheu **sobrescrever ("Linear vence")**. O desenho abaixo é da coordenação, por delegação. Completa a [ADR 0060](0060-importar-do-linear.md) (seção 5) e a [ADR 0061](0061-sincronizar-com-o-linear.md).

## Contexto

A sincronização segue a regra por campo da ADR 0060: só atualiza o campo que mudou no Linear **e** não foi mexido no TreePM. A regra protege o que a pessoa fez aqui, mas tem um custo: um campo mexido aqui uma vez nunca mais acompanha o Linear. Com o tempo, descrição e situação ficam velhas, e não há como dizer "agora quero o que está no Linear".

Apagar os tickets e importar de novo resolveria isso, mas perde o que só existe aqui: comentários e conversas feitos no TreePM, a árvore arrumada à mão ou pela categorização, dependências criadas aqui, notas de trabalho e os números dos tickets. A dor é o campo velho, e ela se resolve sem apagar nada.

## Decisão

### 1. Uma opção da rodada

- A sincronização ganha a opção **"Sobrescrever com o Linear"**. É gravada na rodada ao abrir e vale para todos os passos, seja quem for que os conduza (o navegador, outra aba).
- Só existe em rodada de sincronização (`reimport`). Na primeira importação não há o que sobrescrever, e o pedido com a opção é recusado.
- Se já há uma rodada aberta no projeto, pedir outra com a opção diferente é recusado com erro próprio: a rodada aberta não muda de natureza no meio. A pessoa termina ou abandona a aberta e abre outra.
- Quem pode usar é quem pode sincronizar. Fica só na tela; `start_linear_sync` do MCP não ganha a opção nesta fatia.

### 2. A regra com a opção ligada

Para cada ticket que tem origem no Linear e foi visto na rodada, e para cada campo da lista abaixo: **se o valor do Linear, já mapeado, difere do valor atual do ticket, aplica o do Linear.** A comparação é com o valor atual, não com o retrato: o caso mais comum é o campo mexido aqui sem mudança nenhuma no Linear, em que "mudou no Linear" é falso para sempre.

Campos: título, descrição, prioridade, responsável, prazo, situação, etiquetas e pai.

Depois da rodada, o retrato aplicado é igual ao valor atual e as marcas de "mantido daqui" e de pendência desses campos são limpas. Uma sincronização normal logo em seguida não muda nada e não gera evento; uma mudança posterior no Linear volta a ser aplicada pela regra de sempre.

### 3. O que a opção não faz

- **Não apaga ticket.** Ticket criado aqui, e issue que sumiu do Linear, ficam como estão.
- **Responsável:** quando o Linear tem responsável mas o e-mail está ilegível ou não casa com ninguém, os responsáveis daqui ficam. A opção só esvazia quando a issue está de fato sem responsável no Linear.
- **Situação:** as regras da árvore continuam mandando (concluído com filho aberto, ticket dentro de ideia). O Linear não tem "em revisão": um ticket posto em revisão aqui volta para "em andamento". A tela avisa.
- **Pai:** só volta para o pai do Linear a issue que **tem** pai ou projeto no Linear. Issue solta no Linear fica onde foi posta aqui: é o TreePM que organiza o que o Linear deixa sem lugar, e desfazer isso jogaria fora a categorização e a arrumação manual. Movimento que criaria ciclo continua sendo pulado.
- **Etiquetas:** as etiquetas do Linear que foram tiradas do ticket aqui voltam, e as que saíram no Linear saem. Etiqueta criada aqui (sem origem no Linear) fica no ticket.
- **Comentários e relações:** fora desta fatia. Comentário importado e editado aqui continua com o texto daqui; comentário ou relação removidos aqui não voltam.
- **Nada novo vai a provedor de IA.** A opção só muda qual valor é gravado.

### 4. O que se perde, e a cópia

O valor daqui é substituído. Cada mudança gera o evento automático de sempre, que guarda o valor anterior de título, situação, prioridade, prazo, responsável e pai. Para o campo cujo evento não guarda o valor anterior (a conferir na implementação; a descrição é o candidato), o aviso da tela diz que o texto daqui é substituído e não pode ser recuperado.

### 5. Tela

- No lugar onde hoje se pede a sincronização, uma caixa "Sobrescrever com o Linear o que foi mudado aqui", desmarcada por padrão.
- Marcada, o botão abre uma confirmação que diz, em frases curtas: quais campos voltam a ser os do Linear; que comentários, conversas, tickets criados aqui e a posição das issues soltas não mudam; que "em revisão" volta para "em andamento"; e o que não pode ser recuperado.
- O resumo da rodada mostra quantos tickets tiveram campo sobrescrito (`overwritten`), no lugar de "mantidos porque foram mexidos aqui".
- Usa os componentes de diálogo e de caixa que já existem; não muda o mapa.

## Fora deste recorte (viram tickets)

- Apagar tudo e reimportar do zero.
- Sobrescrever comentários e relações.
- A opção pelo MCP.
- Escolher campo a campo, ou ticket a ticket, o que sobrescrever.

## Consequências

- Passa a existir um jeito de desfazer, de uma vez, as edições feitas aqui nos campos que o Linear também tem. É ação da pessoa, com confirmação.
- A rodada ganha uma coluna, logo há migration (`0049`), aplicada antes do código.
