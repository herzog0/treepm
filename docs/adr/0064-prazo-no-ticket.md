# 0064 — Prazo no ticket

- **Data:** 2026-11-26
- **Situação:** pedido de Teodoro em 2026-11-25 (`TREEPM-467`). No mapa dos atributos do Linear ele marcou "Prazo" (I-02: "data, aviso de atraso no card") e "Datas do projeto" (P-04: "a data-alvo viraria o prazo do ticket pai") como implementar. O desenho abaixo é da coordenação, por delegação. A parte que muda o card do mapa **espera a aprovação dele na tela**, pelo Claude Design. Completa a [ADR 0061](0061-sincronizar-com-o-linear.md).

## Contexto

O ticket do TreePM não tem data nenhuma que alguém escolha: tem só as datas do que aconteceu (criado, iniciado, concluído). Quem importa do Linear perde o prazo das issues, e quem planeja aqui não tem como dizer "isto é para o dia 12".

A dor é dupla: guardar a data combinada, e ver no mapa o que passou dela. A segunda é a que justifica o atributo; uma data escondida na página do ticket ninguém olha.

## Decisão

### 1. O que é o prazo

- Uma data de calendário no ticket, **sem hora e sem fuso**: "12 de dezembro" é o mesmo dia para todo mundo, como no Linear. Opcional; a maioria dos tickets não vai ter.
- Qualquer ticket pode ter prazo, folha ou pai. O prazo do pai não é calculado a partir dos filhos nem imposto a eles: cada um tem o seu, e ninguém é corrigido automaticamente.
- Quem pode editar o ticket pode pôr, mudar e tirar o prazo. A mudança vira evento na linha do tempo, como a de prioridade.

### 2. Atrasado

- Um ticket está **atrasado** quando tem prazo, o prazo é anterior a hoje, e a categoria dele é "a fazer", "em andamento" ou "em revisão". Concluído e cancelado nunca estão atrasados, mesmo que tenham terminado depois do prazo.
- "Hoje" é o dia de quem está olhando, no fuso do navegador. Perto da meia-noite, duas pessoas em fusos diferentes podem discordar por algumas horas; é o preço de não inventar um fuso do projeto, que ninguém pediu.
- Atrasado é **derivado**, como "bloqueado": não é gravado, não é situação e não muda sozinho a situação de ninguém.

### 3. O que o atraso não faz (nesta ADR)

- **Não entra na cor do card nem na propagação para o pai** (ADR 0051). A cor diz em que pé o trabalho está; o atraso é outra pergunta. Misturar as duas faria um pai "em andamento" ficar com cara de problema por causa de um neto com data vencida, e o mapa perderia a leitura que tem hoje.
- **Não muda a ordem da fila de trabalho.** A fila segue prioridade e dependências; prazo como critério de ordem é decisão à parte, depois de ver o uso.
- **Não notifica.** Aviso de prazo chegando e de atraso entra com as notificações (`TREEPM-410`).

### 4. Onde aparece

- **Página do ticket:** campo "Prazo" junto dos outros, com seletor de data e botão de tirar. Atrasado mostra a data em destaque com "atrasado há N dias".
- **Card do mapa** (espera aprovação, ver abaixo): nos níveis de detalhe que mostram texto, a data curta ("12 dez") ao lado dos marcadores que já existem; atrasado, a mesma data com o destaque de atraso. Nos níveis sem texto, só um sinal pequeno quando atrasado; ticket em dia não ganha nada.
- **Busca e filtros:** "atrasados" e "com prazo até…".
- **MCP:** as leituras de ticket trazem `dueDate` e `overdue`; `update_ticket` aceita `dueDate` (data ou nulo), com o alcance de escrita. O "hoje" do MCP é o dia em UTC.
- **Assistente:** o prazo **não vai ao provedor de IA** nesta ADR. É dado do ticket, não de pessoa, e o assistente responderia bem "o que está atrasado?"; mas é categoria nova de dado, e mandar categoria nova a provedor é decisão de Teodoro. Fica perguntado a ele.

### 5. Linear

- `dueDate` da issue vira o prazo do ticket, pela regra por campo da ADR 0060 e pela regra do campo sem retrato da ADR 0061: na primeira sincronização depois desta fatia, os tickets já importados recebem o prazo do Linear se ninguém pôs um aqui; depois, só muda aqui o que mudou lá e não foi mexido aqui.
- `targetDate` do projeto do Linear vira o prazo do ticket que representa o projeto, pela mesma regra. `startDate` do projeto fica de fora: o TreePM não tem data de início planejada.
- Prazo é data de calendário nos dois lados; não há conversão de fuso.

## Telas que passam pelo Claude Design antes da implementação

1. O card com prazo e com atraso, nos níveis de detalhe com texto e sem texto.

O campo na página do ticket e o filtro seguem os padrões que já existem e não esperam.

## Fatias

1. **Banco, API, página do ticket, linha do tempo, MCP e sincronização com o Linear.** Não toca no mapa.
2. **Card do mapa e filtros**, depois da aprovação da tela.

## Em aberto

- Prazo no assistente (pergunta a Teodoro).
- Atraso de descendente resumido no pai (por exemplo "3 atrasados aqui dentro"). Útil num mapa grande, mas é mecanismo novo de propagação; decidir depois de usar o prazo de verdade.
- Prazo como critério da fila de trabalho.

## Consequências

- O ticket ganha a primeira data escolhida por alguém; estimativa, ciclo e marco (`TREEPM-463`) vão se apoiar nela.
- "Atrasado" passa a existir como segundo estado derivado, ao lado de "bloqueado", e todo lugar que lista tickets precisa saber mostrá-lo.

## Como ficou (fatia 1, 2026-11-26)

- Migration `0047_ticket_due_date`, só de acréscimo: `tickets.due_date` do tipo `date`, nula, com CHECK de faixa (2000-01-01 a 2100-12-31). A faixa recusa o erro de digitação que vira ano absurdo, que o seletor de data do navegador deixa passar; vale igual no domínio, na API, no MCP e no Linear.
- **Sem fuso em lugar nenhum.** Na API e no domínio o prazo é o texto `AAAA-MM-DD`. Há uma única conversão para o tipo do banco, em UTC, e os testes rodam em três fusos (UTC, São Paulo e Kiritimati) sem a data andar um dia.
- **A API não diz se está atrasado**: devolve só a data, e a tela compara com o dia do navegador. O MCP devolve `overdue` com o dia em UTC, e a descrição das ferramentas avisa que perto da meia-noite pode divergir da tela.
- **Página do ticket:** campo "Prazo" depois de Prioridade. Só é gravado o que a pessoa mudou: a data digitada vale quando ela confirma (Enter, sair da linha, ou escolher o dia no calendário); focar e sair sem mexer não grava nada, fechar o calendário clicando fora cancela, e tirar o prazo é só pelo botão. Data fora da faixa mostra aviso e não grava. Atrasado mostra a data na cor de erro do tema e "atrasado há N dias" escrito, para a cor não ser o único sinal. A linha de base do layout da página do ticket foi regravada: entrou a linha nova e o que está abaixo desceu 34 px; nada mais mudou.
- **Linha do tempo:** "definiu o prazo", "mudou o prazo de… para…" e "tirou o prazo". Sem notificação.
- **Linear:** `dueDate` da issue e `targetDate` do projeto, pela regra por campo e pela do campo sem retrato, usando os retratos que já existiam (sem coluna nova). A revisão achou que um campo vazio nos dois lados nunca ganhava retrato em ticket importado antes da fatia, o que prendia o campo em "mantido daqui" para sempre; corrigido, e o mesmo defeito existia no líder do projeto (ADR 0061, fatia 1). Custa 0,1 ponto a mais por item na consulta. Valor malformado é ignorado e contado; não mexe no prazo daqui.
- **IA:** o prazo não vai a nenhum provedor. Há teste com data sentinela em todos os caminhos (conversa do ticket, Meu chat, consulta do assistente, procura do lugar, categorização, vetor, resumo de ramo), e ele foi quebrado de propósito para provar que pega o vazamento.
- **Ideia nunca fica atrasada.** Ticket marcado como ideia pode ter prazo, mas não aparece como atrasado: ideia não é trabalho combinado.
- **Linear, chave ausente:** se a resposta do Linear não traz o campo, vale "não lido" e nada muda aqui; só o nulo explícito tira o prazo.
- **Quem cria ou copia ticket não inventa prazo:** importação por lista e criação pelo assistente nascem sem; mover mantém.
