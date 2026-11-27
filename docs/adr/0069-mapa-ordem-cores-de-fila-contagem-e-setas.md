# 0069 — Mapa: ordem pelas dependências, cores de fila, contagem no pai e setas ao selecionar

- **Data:** 2026-11-27
- **Situação:** pedido de Teodoro em 2026-11-27 (`TREEPM-572`), decidido com ele em conversa; nada implementado. Ele pediu que o mapa dê "o mesmo grau de visibilidade de interdependência" de um quadro de passos e que reduza "a carga cognitiva de decidir qual é o próximo item". Vem depois da [ADR 0068](0068-pai-e-pedaco-ordem-e-dependencia-bloqueio-e-impedimento.md), que definiu os termos usados aqui. Soma capacidades ao mapa aprovado em 2026-11-19: zoom, arrasto, seleção e níveis de detalhe continuam iguais. As cores novas esperam o olho dele na tela.

## Contexto

Com a ADR 0068 o mapa passou a mostrar a árvore certa ("faz parte de"), e o servidor sabe o lugar de cada ticket na fila. O mapa ainda não mostra isso: os filhos aparecem em ordem de número, um ticket livre tem a mesma cor de um que espera há dez passos, um pai visto de longe parece vazio, e nenhuma dependência aparece.

## Decisão

### 1. A lista do projeto leva as dependências

Cada ticket da lista do projeto traz os tickets de que ele depende, com o tipo ("para começar" ou "para entregar"). O mapa calcula o resto no navegador.

### 2. Ordem dos irmãos

- O **passo** de um ticket é 0 quando ele não depende de ninguém para começar; nos outros casos, é 1 mais o maior passo dos tickets de que ele depende para começar. O passo de um ticket com filhos é o menor passo dentro dele.
- Dentro de cada pai, os filhos aparecem por passo, do menor para o maior. No empate: prioridade efetiva, depois número.
- O **habilitador** é o filho de que algum irmão depende para começar e que não depende de nenhum irmão. Pela regra acima ele já aparece primeiro; ele ganha a marca "abre os irmãos".
- O motor do mapa continua recebendo os irmãos já em ordem (a ordem de entrada); quem ordena é a aplicação.

### 3. Cores de fila

- Um ticket "a fazer" e sem filhos usa a cor do lugar na fila: **livre**, **próximo** ou **esperando**. As outras situações (em andamento, em revisão, concluído, cancelado) e o bloqueado mantêm as cores da ADR 0051.
- Na subida para os pais, a ordem do mais preocupante passa a ser: bloqueado › em andamento › em revisão › livre › próximo › esperando / a fazer › concluído.
- Os tons saem de uma fonte só, como os outros (`situation.ts` e os tokens do tema), e valem no mapa, no marcador e na página do ticket.

### 4. Três números em todo pai

Todo ticket com filhos mostra, da subárvore inteira: quantos tickets, quantos prontos, quantos livres. Exemplo: "31 tickets · 12 prontos · 2 livres". Os números aparecem em todo nível de detalhe em que o card tem texto; nos níveis sem texto eles ficam no rótulo acessível e na dica do ponteiro. Ideias e cancelados ficam fora da conta, como no progresso de hoje. Isso troca a regra "sem badge +N" dos grupos: o grupo continua sem badge, e quem conta é o card do pai.

### 5. Setas ao selecionar

- Selecionar um ticket desenha as dependências dele, e só as dele: uma cor para o que ele espera, outra para o que ele libera. "Para entregar" é tracejada.
- A seta liga os cards onde eles estão na tela. Quando a outra ponta está dentro de um pai fechado ou de um grupo, a seta vai até o que está visível. Quando está fora da tela, a seta vai até a borda.
- Tirar a seleção apaga as setas. Nada é desenhado sem seleção.

## Alternativas descartadas

- **Faixas por área com colunas de passo como tela principal.** Protótipo feito e mostrado; Teodoro preferiu manter o mapa com zoom como tela principal e ter a árvore explodida como segunda visão (`TREEPM-573`).
- **Desenhar todas as dependências sempre.** No projeto de referência são 265; vira um novelo. O blueprint já dizia "não desenhar toda a rede sobre toda a árvore".
- **Calcular o passo no servidor.** O mapa precisa das dependências de qualquer forma, para as setas.

## Consequências

- A posição dos tickets muda na primeira abertura depois da mudança, como na ADR 0067: o layout é calculado.
- A ordem dos irmãos muda quando uma dependência muda.
- A lista do projeto fica maior: uma entrada por dependência.

## Em aberto

- Os tons de livre, próximo e esperando, depois de Teodoro olhar a tela.
