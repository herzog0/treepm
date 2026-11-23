# ADR 0046 — A atualização automática do mapa é condicional, pela versão do projeto

- **Data:** 2026-11-23
- **Estado:** proposta da coordenação, pelos padrões que Teodoro aceitou em 2026-11-22; implementação em `TREEPM-246`.

## Contexto

Desde a ADR 0043 o mapa se atualiza sozinho a cada 30 s, para mostrar o que outra pessoa ou um agente mudou. A atualização repete a carga inicial: baixa a lista inteira de cada projeto e compara com a que já tem. A medição com projeto grande (`docs/medicoes/2026-11-22-projeto-grande.md`) mostrou o custo disso com 20 000 tickets: 351 ms de servidor e 13 MB por projeto, a cada 30 s, por pessoa com o mapa aberto, mesmo quando nada mudou, que é o caso quase sempre.

Uma atualização incremental de verdade (só os tickets que mudaram) esbarra em campos do resumo que são derivados de outros tickets: o progresso de um pai muda quando um descendente muda, e a marca de ideia de um ramo inteiro muda quando a raiz é aceita. Dizer "o que mudou" exige calcular o alcance de cada mudança, e errar esse alcance deixa o mapa mostrando dado velho sem ninguém perceber.

## Decisão

A atualização automática passa a perguntar primeiro **se** o projeto mudou, e só baixa a lista quando mudou.

- **Versão do projeto:** a API calcula, para cada projeto, um valor barato que muda sempre que qualquer coisa que aparece no resumo dos tickets muda: criação, remoção, título, descrição, situação, pai, pessoas, estágio de ideia, marcador de trabalho pela IA. É derivado do que o banco já guarda (por exemplo quantidade de tickets, maior data de alteração e o último evento do projeto), sem coluna nova se isso bastar. Custo constante, que não cresce com o tamanho do projeto.
- **Resposta condicional:** a lista de tickets do projeto devolve a versão como `ETag`. A atualização automática manda `If-None-Match` com a versão que tem; se for a mesma, a API responde `304` sem corpo e sem montar a lista. Se mudou, responde a lista inteira, como hoje. O contrato do corpo não muda.
- **Na dúvida, a versão muda.** Mudar a versão sem necessidade custa uma lista a mais; não mudar quando deveria deixa o mapa velho. Toda escrita que afeta o resumo tem de mexer em algo que a versão lê, e um teste percorre as escritas conhecidas e confere que cada uma muda a versão.
- **Permissão antes de tudo:** a conferência de quem pode ver o projeto acontece antes de comparar a versão; quem não vê recebe o mesmo `404` de hoje, nunca um `304`.
- **O que depende do relógio não entra na versão:** o marcador de trabalho pela IA expira por tempo, e a web já apaga o contorno pelo próprio relógio.
- **A carga inicial e a recarga depois de uma ação da própria pessoa** continuam baixando a lista (podem aproveitar o mesmo mecanismo, sem obrigação).

## Alternativas descartadas

- **Atualização incremental por ticket alterado.** É o destino provável, mas o risco de dado velho por causa dos campos derivados não se paga agora: com a resposta condicional, o custo some em quase todas as atualizações.
- **Canal em tempo real (WebSocket ou eventos do servidor).** Resolve também a demora de até 30 s, mas pede infraestrutura de conexão persistente na publicação, que ainda não existe.
- **Aumentar o intervalo.** Só adia o problema e piora o que a ADR 0043 quis resolver.

## Em aberto

1. Atualização incremental por ticket, quando houver projetos em que as mudanças sejam frequentes o bastante para a lista inteira voltar a pesar.
2. Compressão das respostas (`TREEPM-255`), que reduz o custo da lista quando ela é de fato baixada.
3. As mesmas respostas condicionais para projetos e pessoas, que o mapa também recarrega.

## Como ficou (2026-11-23)

- **A versão é um contador próprio:** `projects.tickets_version` (migration `0026`), somado de um em um. A primeira implementação usava a data de alteração do projeto, que outras operações também gravam com o relógio do servidor e que poderia recuar com mais de uma instância; a revisão independente apontou e foi trocada. O `ETag` é fraco, `W/"v2.<contador>"`, porque o que depende do relógio (marcador de trabalho pela IA que vence) pode mudar o corpo sem mudar a versão.
- **Quem avisa:** toda escrita que muda algo do resumo marca o projeto na transação, e `withTenant` grava o contador uma vez, como último comando antes de confirmar. A linha do projeto fica travada só nesse instante, então editar um ticket não espera outras escritas do mesmo projeto. Marcar fora de uma transação lança erro. A decisão de marcar usa o que foi lido depois da trava de linha, ou é incondicional.
- **Ordem das travas:** trava de estrutura (ADR 0045), linhas de tickets, linha do projeto por último. A criação e a importação reservam o número do ticket na linha do projeto; por isso travam antes o pai, os tickets mencionados e os que citam a chave nova, e reabrem os ancestrais antes da reserva.
- **Inventário:** criar, importar, criação pela conversa (com agrupador e com filhos), título, descrição, situação, pai, prioridade, pessoas, estágio de ideia, aceitar, descartar e transformar em ideia, marcador de trabalho pela IA (ligar, desligar, encerrar ao concluir e ao arquivar), criar e remover dependência, remover ticket, e as escritas pelo MCP. Um teste percorre cada uma e confere que a lista e a versão mudam; outro roda sequências aleatórias e confere que versão igual implica lista igual. Foi esse segundo que pegou as dependências, que passaram a contar quando o resumo ganhou "depende de ticket aberto" (ADR 0047).
- **Contrato:** permissão antes de tudo (quem não vê o projeto recebe o `404` de sempre); `If-None-Match` igual dá `304` sem corpo e sem montar a lista; `Cache-Control: private, no-cache`. Na web, a atualização automática manda a versão de cada projeto e, no `304`, reaproveita a mesma lista, sem nenhum render.
- **Medição com 20 000 tickets:** a atualização de 30 s sem mudança caiu de cerca de 330 ms e 12,9 MB para cerca de 14 ms e 3,9 KB.
- **Fora da API:** escrita direta no banco (o gerador de projeto grande, SQL manual) não muda a versão; o mapa só percebe na próxima escrita pela API.
- **Em aberto, além do que já estava:** o caso raro em que uma criação sem pai disputa o número com outra e um ticket que cita a chave nova fica sem a trava antecipada; a requisição vira "tente de novo", nunca dado errado.
