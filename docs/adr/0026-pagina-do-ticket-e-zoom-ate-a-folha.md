# ADR 0026 — Página do ticket no mapa e zoom máximo até a folha

**Status:** Aceita, com dois pontos provisórios marcados no texto. **Data:** 2026-11-20.

## Contexto

A [ADR 0024](0024-tickets-primeiro-recorte-e-importacao-por-lista.md) entregou a API de tickets e a [ADR 0025](0025-base-visual-constelacao-e-tema-do-mapa.md) pôs os tickets no mapa, mas a interface ainda não abre, cria, edita nem remove um ticket. A única entrada é a importação de uma lista.

Em 2026-11-20 Teodoro decidiu:

- **Proposta visual aprovada inteira** ([TreePM — proposta visual](https://claude.ai/artifact/Mt7furZnr5y5gFRiqgWG8D)), incluindo o quadro "Ticket aberto: página lateral e foco". As pranchas que a ADR 0025 deixou de fora passam a valer como referência.
- **Gesto que abre o ticket:** o clique continua selecionando sem mover a câmera. O ticket abre por Enter, por um segundo clique ou por um botão "Abrir". Ele aprovou a sugestão com as três formas, e esta ADR adota as três.
- **Zoom máximo:** "o nível máximo de zoom deveria me permitir ver todo o conteúdo de um card folha, grande, que nem eu vejo de um card pai quando já consigo ver seus filhos". Esse é o pedido explícito que autoriza mudar o limite de zoom do mapa.

Hoje o limite de zoom vem do pacote: a câmera para quando o menor nó do mapa chega a 140 px de largura. Como cada nível tem cerca de um quinto da largura do nível acima, uma folha funda nunca passa de um card pequeno, enquanto um ticket pai chega a ocupar a tela.

## Decisão

`packages/engine` e `packages/react` não mudam. Tudo é feito em `apps/web`, com o que o controlador do mapa já expõe (`selectNode`, `focusNode`, `fitBounds`, `cameraOptions`). A API não muda.

### Zoom máximo até a folha

O mapa da organização passa a permitir zoom até o menor nó chegar a **440 px** de largura na tela, a mesma largura do card em foco no quadro aprovado. O limite é calculado na web a partir do layout dos itens e passado ao mapa como escala máxima. O piso de escala que o pacote já aplica (6) é mantido: em árvore pequena, só com a organização e projetos, o zoom continua indo até onde já ia, além dos 440 px.

- "Explorar ramo", o enquadramento inicial, os gestos, o passo dos botões de zoom e os limiares de nível de detalhe não mudam.
- O card cresce, mas o conteúdo é o do nível "completo" (chave, título, marcador com situação ou progresso) no mesmo tamanho de letra de hoje, no canto do card; o resto do card fica vazio. É como o card de um ticket pai já aparece quando está grande. Texto maior e mais conteúdo são o nível "detalhe", decidido depois na [ADR 0027](0027-card-detalhe-no-mapa.md).
- `?demo` não muda.

### Abrir um ticket

Selecionar e abrir são coisas diferentes. Só ticket abre; organização e projeto continuam como estão.

- **Segundo clique:** ativar um ticket que já está selecionado abre o ticket. Vale para o clique e para o Enter com o foco do teclado no nó, que o navegador já trata como clique. O primeiro clique continua só selecionando.
- **Enter:** com um ticket selecionado e o foco no mapa, fora de campo de texto e de outro controle, Enter abre o ticket.
- **Botão "Abrir"** no cartão de seleção, ao lado de "Explorar ramo".

O ticket aberto fica na URL, como estado do mapa: `?ticket=<id>`, sem `view`. Abrir usa `history.pushState`; voltar do navegador fecha a página. Um endereço com `ticket` abre a página ao carregar. Ticket inexistente ou invisível mostra a mensagem correspondente dentro da página, com a ação de fechar. Trocar de seção ou de organização descarta o parâmetro.

### O mapa desliza e foca

Com a página aberta, o mapa ocupa só a área à esquerda dela e a câmera enquadra o ticket nessa área.

- A página tem 620 px de largura, à direita. Em tela com menos de 1.000 px de largura ela cobre o mapa inteiro, sem deslize.
- Ao abrir, o ticket fica selecionado e a câmera o leva a cerca de 440 px de largura, ou ao que couber na área visível, inteiro e com os filhos aparecendo abaixo. A animação é a da câmera do pacote e respeita a preferência de movimento reduzido.
- A página substitui o cartão de seleção do ticket aberto e fecha o painel de áreas e projetos. Abrir o painel fecha a página.
- Com a página aberta, clicar em outro nó segue a regra de sempre: seleciona, mostra o cartão de seleção ao lado da página e não troca o ticket aberto. Abrir o outro ticket troca a página.
- **Fechar:** botão "Fechar e voltar ao mapa", Esc (fora de edição) ou voltar do navegador. O mapa volta a ocupar a largura inteira. Substituído pela [ADR 0028](0028-preferencias-por-usuario-e-pagina-de-configuracoes.md): por padrão a câmera volta ao lugar de antes, e a pessoa pode escolher que ela fique onde está.
- O foco do teclado vai para o título da página ao abrir e volta ao mapa ao fechar. A página é uma região complementar com nome, não um diálogo modal.

### Conteúdo da página

Carregado de `GET /api/tickets/:id`, na ordem do quadro aprovado:

1. **Cabeçalho:** chave, caminho dos ancestrais (projeto e tickets pais) e o botão de fechar.
2. **Título.**
3. **Situação**, em ticket folha: marcador com o nome e a troca entre as cinco situações. Em ticket com filhos, **Progresso**: marcador com "n de m concluídos", sem edição.
4. **Pessoas:** as pessoas atribuídas, "Adicionar" e a remoção de cada uma.
5. **Ticket pai:** chave e título do pai, ou "Raiz do projeto". Clicar no pai abre o pai. "Mudar" abre a escolha de outro pai.
6. **Descrição.**
7. **Subtickets:** filhos diretos com marcador, chave, título e situação ou progresso; clicar em um abre esse ticket. "Novo subticket" fica aqui, também quando a lista está vazia.

Ficam fora deste recorte, embora apareçam nos quadros: a seção **Atividade**, que depende de uma rota de leitura de eventos e entra com "Histórico visível do ticket"; e a seção **Mudança de lugar**, que depende da IA (IDEA-014).

### Edição

- **Título e descrição** têm modo de edição com "Salvar" e "Cancelar". Salvar envia um `PATCH` com os campos alterados. Esc cancela a edição sem fechar a página.
- **Situação, pessoas e pai** aplicam na hora, uma chamada por mudança, como as telas da [ADR 0023](0023-telas-de-administracao-e-mapa-da-organizacao.md).
- **Mudar o pai:** escolha entre "Raiz do projeto" e os tickets do mesmo projeto, com filtro por chave e título. O próprio ticket e seus descendentes não aparecem. A API continua sendo quem valida (`ticket_cycle`).
- **Adicionar pessoa:** escolha entre as pessoas ativas da organização que ainda não estão no ticket. A API valida o acesso ao projeto (`person_without_project_access`, `person_inactive`).
- **Remover o ticket:** ação destrutiva com o segundo clique no mesmo lugar, só para quem pode remover. Depois de remover, a página fecha e a seleção é limpa. Ticket com filhos mostra a mensagem do `ticket_has_children`.
- Erro de cada ação aparece junto do controle que a disparou e some na próxima ação bem-sucedida da mesma região. Não há controle de versão: se duas pessoas editarem o mesmo ticket, vale a última gravação.
- Depois de cada mudança, a página e o mapa recarregam os dados, sem perder a câmera nem o ticket aberto. Quando a mudança tira o ticket aberto do lugar no mapa, como na mudança de pai, a câmera volta a enquadrá-lo.

### Criação manual

A página tem um modo de criação, com título obrigatório e descrição opcional, "Criar" e "Cancelar". O ticket nasce em "a fazer" e sem pessoas; o resto se ajusta depois de criado. O modo de criação não vai para a URL. Depois de criar, a página passa a mostrar o ticket novo (`?ticket=<id>`), o mapa recarrega e a câmera vai até ele.

- **"Novo subticket"**, na página de um ticket: cria um filho dele.
- **"Novo ticket"**, no detalhe do projeto no painel lateral, ao lado de "Importar lista": cria um ticket na raiz do projeto.

**Provisório:** o botão flutuante "Novo ticket" dos quadros pertence à conversa com a IA (IDEA-005) e não entra agora. Quando a conversa existir, ela passa a ser a entrada principal e a criação manual continua nesses dois lugares.

### Permissões na interface

As mesmas da ADR 0024, aplicadas pela API e refletidas na página:

- Quem vê o projeto vê a página, só para leitura.
- Administrador da organização, gestor e colaborador do projeto criam, editam, mudam situação e pai e atribuem pessoas.
- Administrador da organização e gestor removem.
- Em projeto arquivado a página é só de leitura e avisa o motivo. O mapa não mostra projeto arquivado, então nesse caso a página abre pelo endereço sem nó para selecionar nem foco da câmera.

## Consequências

- O TreePM passa a ser usável para o próprio trabalho sem importação: criar, abrir, mudar situação e reorganizar tickets pela interface.
- O zoom vai bem mais fundo do que antes. Com a folha em 440 px, os ancestrais ficam com milhares de pixels e saem da tela; o caminho no topo e "Explorar ramo" são o jeito de voltar.
- O limite de zoom do mapa autenticado passa a ser diferente do da demo.
- A página guarda o ticket aberto na URL, o primeiro estado do mapa que vai para o endereço. A câmera continua fora da URL.
- A seção de atividade aprovada no quadro fica sem implementação até existir a rota de eventos.
- Sem controle de versão na edição, uma gravação pode sobrescrever outra feita ao mesmo tempo. Fica registrado como limite deste recorte.
