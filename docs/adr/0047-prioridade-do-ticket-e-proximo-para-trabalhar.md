# ADR 0047 — Prioridade do ticket e o próximo ticket para trabalhar

- **Data:** 2026-11-23
- **Estado:** decisão da coordenação, por delegação de Teodoro em 2026-11-23 ("você toma as decisões por mim baseado nos melhores critérios de usabilidade e design"); reversível. Implementação em `TREEPM-220`.

## Contexto

Pedido de Teodoro em 2026-11-22: "a gente poder selecionar prioridade do ticket e aí um botão de 'next ticket to work on' pega o próximo ticket dada prioridade dele. pode ser um número inteiro (incluso negativos)."

Hoje nada diz o que fazer primeiro. O produto já sabe várias coisas que uma fila de trabalho precisa respeitar: a situação, o "ticket da vez" (ADR 0034), as dependências entre tickets, as ideias, que ficam fora do processo (ADR 0042), quem é responsável, e o marcador de trabalho pela IA (ADR 0043).

## Decisão

### O campo

- Todo ticket tem uma **prioridade**: número inteiro, de -999 a 999, **0 por padrão**. **Número maior vem primeiro**; negativo empurra para o fim. Um número só, sem nomes como "alta" e "baixa": foi o que ele pediu, e deixa cada time usar a escala que quiser.
- **Quem muda:** quem pode editar o ticket. A mudança entra no histórico ("mudou a prioridade de 0 para 5").
- **Prioridade herdada:** um ticket com prioridade 0 vale a prioridade do ancestral mais próximo que tenha uma diferente de 0. Assim, priorizar um ramo prioriza o que está dentro dele sem editar cada filho, e um filho com prioridade própria continua mandando em si mesmo. A página mostra as duas coisas quando diferem ("0 · vale 5, de ABC-12").
- Ideia tem prioridade como qualquer ticket, para a triagem, mas não entra na fila de trabalho.

### Onde aparece

- **Página do ticket:** uma linha "Prioridade" entre as propriedades, com o número e botões de menos e mais; dá para digitar. Sem campo novo na criação: ticket nasce com 0.
- **Mapa:** o desenho aprovado dos cards não muda. A prioridade não aparece no card.
- **Lista de itens do pai, na página do ticket:** os filhos passam a mostrar a prioridade própria quando diferente de 0, discreta, ao lado da situação.

### A fila "próximos para trabalhar"

É uma lista ordenada, não um ticket só; "o próximo" é o primeiro dela.

- **Entra na fila** o ticket que: está "a fazer"; pode ser trabalhado agora, isto é, não tem filhos abertos (é folha, ou é o ticket da vez de um ramo cujos filhos terminaram); não é ideia nem está dentro de uma; não depende de ticket ainda aberto; não está com o marcador de trabalho pela IA ligado; e é da pessoa ou não é de ninguém (ticket só de outras pessoas fica fora).
- **Ordem:** prioridade que vale (herdada ou própria), da maior para a menor; depois os que já são da pessoa antes dos sem responsável; depois a ordem da árvore (o número do ticket).
- **Alcance:** o ramo selecionado no mapa (projeto ou ticket); sem seleção, tudo o que a pessoa enxerga.
- **O que acontece ao pedir o próximo:** a câmera vai até o ticket e a página dele abre. Nada é mudado: não atribui nem passa para "em andamento". Quem decide começar é a pessoa.
- **Sem nenhum:** uma frase dizendo que não há ticket pronto para trabalhar nesse alcance, e por quê quando houver um motivo único (tudo depende de outro ticket, tudo é de outra pessoa).
- **Onde pedir:** é um dos modelos do botão play (ADR 0048) e uma linha da barra de pedidos ("Próximo ticket para trabalhar").

### Agentes

As leituras do MCP passam a trazer a prioridade de cada ticket. Mudar prioridade pelo MCP e uma ferramenta "próximo ticket" para agentes ficam em aberto.

### Banco

`tickets.priority`, inteiro, não nulo, padrão 0, com conferência do intervalo. Migration própria.

## Alternativas descartadas

- **Níveis com nome (urgente, alta, normal, baixa).** Mais fácil de ler, mas não é o que foi pedido e engessa a escala.
- **Ordenar os filhos à mão dentro do pai.** Dá ordem total, mas só entre irmãos; não responde "o que faço agora" olhando o projeto inteiro.
- **Somar as prioridades do caminho.** Mais expressivo e bem mais difícil de explicar na tela.
- **Atribuir e iniciar ao pedir o próximo.** Um clique a menos, mas muda dado sem a pessoa pedir, e duas pessoas pedindo ao mesmo tempo disputariam o ticket.

## Em aberto

1. Mudar prioridade e pedir o próximo pelo MCP.
2. Mostrar a prioridade no card do mapa.
3. Prioridade por pessoa (a minha ordem), diferente da do time.

## Como ficou (PRs #172 e #174, 2026-11-23)

- **Banco e API (PR #172, migration `0025`):** `tickets.priority`; o resumo do ticket traz `priority` e `blocked`; o detalhe traz `effectivePriority { value, from }`; `PATCH { priority }`; o histórico ganhou `priority_changed`. As regras ficam no domínio: `effectivePriority`/`effectivePriorities` (`packages/domain/src/priority.ts`) e `workQueue`/`emptyQueueReason` (`work-queue.ts`).
- **Tela (PR #174):** linha "Prioridade" na página do ticket, com menos, mais e o número; quando o valor que vale vem de um ancestral, a linha diz de qual ("vale 5, de ALFA-1"). "Próximo ticket para trabalhar" é uma opção da barra de pedidos: abre o primeiro da fila sem mudar nada, e com a fila vazia diz o motivo.
- **MCP (PR #177):** `get_work_queue` e `set_ticket_priority`, pela mesma função e pelo mesmo serviço da tela.
- **Conferência:** suíte de navegador rodada (254 testes) e capturas olhadas pela coordenação. Não foi usada por Teodoro com sessão real.
