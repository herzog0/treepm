# 0067 — Mapa: áreas ajustadas ao conteúdo e árvore mais larga do que alta

- **Data:** 2026-11-26
- **Situação:** pedido de Teodoro em 2026-11-26 (`TREEPM-559`): "O layout fica esquisito quando a árvore não é muito esparsa. Os campos dos tickets crescem em altura absurdamente. Faz a altura ter um fit para cada área de ticket. Ou faça com que a árvore fique um pouco mais larga […] Largura é melhor do que altura num projeto desses, porque os monitores são mais largos do que altos." O desenho abaixo é da coordenação, por delegação. Muda a disposição dos filhos no motor do mapa (`packages/engine`); não muda zoom, gestos, níveis de detalhe nem cores.

## Contexto

O motor põe os filhos de um ticket numa grade abaixo dele. Duas regras de hoje causam o problema:

- **Toda casa da grade tem o tamanho do maior irmão.** Um filho com subárvore alta faz todas as casas ficarem altas, inclusive as de filhos que são um card só. Numa árvore densa, sobra muito espaço vazio em altura.
- **O número de colunas é a raiz quadrada da contagem de filhos.** A conta é em quantidade, não em tamanho: com filhos altos, a região fica mais alta do que larga, e a tela é mais larga do que alta.

## Decisão

1. **Cada filho ocupa o próprio tamanho.** Numa linha, cada filho tem a largura da própria subárvore. A altura da linha é a do filho mais alto daquela linha, não a do mais alto entre todos os irmãos.
2. **A quebra em linhas prefere largura.** Os filhos continuam na ordem de hoje, da esquerda para a direita e de cima para baixo. O motor escolhe quantos filhos vão por linha de modo que a região dos filhos fique o mais perto possível de uma proporção alvo, medida em tamanho real (largura ÷ altura), e mais larga do que alta. A proporção alvo é uma constante única do motor, começando em 3:1; no empate, vence o arranjo mais largo.
3. **Poucos filhos ficam numa linha só** quando isso não passa muito do alvo. O que decide é a proporção, sem regra especial por contagem.
4. **O resto fica como está:** os filhos alinhados pelo topo da linha, centralizados sob o pai, o espaçamento entre irmãos, a redução de escala dos filhos em relação ao pai e as raízes lado a lado.

## Consequências

- A posição de quase todo ticket no mapa muda na primeira vez que a pessoa abrir depois da mudança. Não há posição gravada: o layout é calculado.
- Árvores densas ficam mais baixas e mais largas; árvores esparsas mudam pouco.
- Linhas de alturas e larguras diferentes deixam a grade menos regular. É o preço de não esticar as áreas.
- A proporção alvo é um número a calibrar olhando um projeto real (`TREEPM-561`).

## Como ficou (2026-11-26)

- **Medida da proporção:** o erro relativo da altura em relação à altura ideal para aquela largura (`|alvo × altura ÷ largura − 1|`), e não a distância em logaritmo. Região alta demais custa sem limite; larga demais custa menos. É o que faz 3 ou 4 filhos ficarem numa linha só.
- **Linhas equilibradas:** o motor escolhe o número de linhas, e os filhos se distribuem por igual na ordem (diferença máxima de um filho entre linhas). Sem isso apareciam linhas órfãs, como 5+1.
- **A quebra é escolhida uma vez**, antes da redução de escala, e reaproveitada depois. A busca é exata (de 1 a n linhas): 15 ms num pai com 2.000 filhos, sem diferença medível numa árvore de 10.000 tickets.
- **Opção `childRegionAspect`** no motor, com o padrão na constante `TARGET_CHILD_REGION_ASPECT = 3`.
- **Custo conhecido (`TREEPM-564`):** com 3:1 os tickets de topo ficam cerca de 30% menores em relação ao projeto, porque a redução de escala limita o raio da região dos filhos e uma linha larga tem raio maior. Com 2:1 os cards ficam maiores, mas 3 e 4 filhos voltam a quebrar em duas linhas.
- **Publicado antes do fim da suíte completa**, por instrução de Teodoro ("mescla e pede o deploy, depois vc testa"); os testes do motor e do mapa já tinham passado.
