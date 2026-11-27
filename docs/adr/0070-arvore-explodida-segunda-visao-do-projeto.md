# 0070 — Árvore explodida: a segunda visão do projeto

- **Data:** 2026-11-27
- **Situação:** pedido de Teodoro em 2026-11-27 (`TREEPM-573`), decidido com ele em conversa e com um protótipo; nada implementado. Ele disse: "A tela principal continua sendo a árvore com zoom infinito que a gente tem hoje, mas vai ter uma segunda possibilidade de visualização", "também com zoom", com "canvas arrastável, mas os itens ficam estáticos". Vem depois das ADRs [0068](0068-pai-e-pedaco-ordem-e-dependencia-bloqueio-e-impedimento.md) e [0069](0069-mapa-ordem-cores-de-fila-contagem-e-setas.md). O mapa não muda.

## Contexto

O mapa mostra "faz parte de": cada ticket dentro do seu pai. A ordem do trabalho aparece nele pela posição dos irmãos e pelas setas do ticket selecionado. Falta uma tela que mostre o projeto inteiro como caminho: o que vem antes, o que vem depois, por onde o trabalho corre. O protótipo com os 80 tickets de um projeto real mostrou que essa leitura funciona da esquerda para a direita, com uma seta por ticket.

## Decisão

1. **Uma segunda visão, ao lado do mapa.** Um controle na tela do projeto troca entre "Mapa" e "Árvore explodida". O mapa é a visão inicial. O endereço guarda a visão, e o navegador lembra a última escolha da pessoa.
2. **O que entra.** A partir do que está em foco (o projeto, ou um ticket com filhos), fora ideias: um ticket vira card quando não tem filhos, ou quando participa de alguma dependência. O que está dentro de um card fica guardado nele, com a contagem ("+N"), e as dependências de dentro sobem para o card. Um ticket com filhos e sem dependência é só um agrupador: não vira card, e a visão desce para dentro dele. Motivo: no Linear as dependências ficam na história, e a história tem sub-issues; desenhar as sub-issues no lugar da história apagava todas as setas.
3. **Colunas de passo.** O passo é o da ADR 0069. A coluna 0 fica à esquerda; o tempo corre para a direita.
4. **Cada ticket pendura no último ticket de que depende para começar**: o de maior passo; no empate, o de menor número. Quem não depende de ninguém é raiz. As linhas saem dessa árvore: as folhas ocupam linhas seguidas, e cada ticket fica na altura do meio dos que penduram nele.
5. **Uma seta por ticket, sempre visível**: do ticket em que ele pendura até ele. Ao selecionar um ticket, aparecem todas as dependências dele, com as cores e o tracejado da ADR 0069.
6. **Dependência que aponta para fora do foco** aparece como um card apagado na coluna do passo dele, sem as dependências próprias.
7. **Cards próprios, cabeçalho e frase.** O card desta visão é pequeno: o código em negrito e o título numa linha. Só livre e próximo usam cor forte; o resto fica calmo. Cada coluna tem o cabeçalho "Passo N", e uma frase no topo diz "Pegue agora: … · Abre em seguida: …". A visão abre num zoom legível, com o passo 0 na esquerda. (Ajuste de 2026-11-27, depois de Teodoro olhar a primeira versão com um projeto real: "isso que eu tô vendo aqui […] não ajuda em nada".)
8. **Zoom e arrasto como no mapa**: a roda aproxima no ponto do cursor, arrastar move a tela, os mesmos atalhos. Os cards ficam parados; nada se rearruma com o zoom. Com o zoom longe, o card vira um retângulo com a cor.
9. **Clique para abrir o ticket**, como no mapa.
10. **Textos nos três idiomas.**

## Alternativas descartadas

- **Faixas por área com colunas de passo.** Mostrava a ordem e o encaixe juntos, mas escondia os caminhos. Teodoro preferiu a árvore.
- **Substituir o mapa.** Ele pediu as duas e quer medir qual é mais usada (`TREEPM-576`).
- **De cima para baixo.** Ele preferiu da esquerda para a direita.

## Consequências

- Um projeto com muitas dependências fica largo (um passo por coluna) e alto (uma linha por folha da árvore). O zoom resolve.
- Um ticket com várias dependências mostra só uma seta até ser selecionado.
- A visão é só de leitura nesta ADR. Editar por ela é assunto do modo de edição (`TREEPM-574`).

## Em aberto

- Medir o uso de cada visão (`TREEPM-576`).
