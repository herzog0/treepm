- Fechamento da Fase 1: organização segura
  Pendências para a Fase 1 cumprir a condição de saída do blueprint.
  - [x] Testar as telas de administração com sessão real
    Os dez passos do roteiro da issue #1 passaram em 2026-11-19, com Clerk de desenvolvimento e Neon reais.
  - [x] Criar o arquivo de variáveis locais da web no checkout principal
  - [ ] Sincronizar pessoas com o Clerk por webhook
    `people.active` só muda com sincronização. Exige ADR: verificação de assinatura, idempotência e eventos fora de ordem.
  - [ ] Exercitar o retorno do Google para conta sem organização
    Caminho da ADR 0020 que nunca foi testado com conta real.
  - [ ] Buscar `/api/me` uma única vez por sessão
    Hoje o indicador do cabeçalho e o Workspace fazem a mesma chamada. No teste com sessão real, cada carga fez cerca de quatro chamadas a `/api/me` e duas a `/api/projects`.
  - [ ] Atualizar os papéis da pessoa depois de uma mudança de papel
    `me.roles` só muda ao recarregar a página.
  - [ ] Limpar a mensagem de erro de área depois de outra ação bem-sucedida
    "Já existe uma área com esse nome." continua visível depois de renomear outra área.
  - [ ] Dar nome próprio aos seletores do detalhe do projeto
    Pessoa, papel e time só são nomeados pelo rótulo que os envolve, e o nome acessível inclui a opção selecionada.
  - [ ] Registrar arquivar, desarquivar e renomear projeto como eventos distintos
    Hoje os três ficam como `project.updated`.
  - [ ] Reduzir as idas ao banco por requisição
    Medido em teste: 17 comandos SQL no detalhe de um ticket e na importação, 19 na edição e 23 na criação e na atribuição, a maior parte de controle da transação. No teste com sessão real, 6 itens levaram 4,2 segundos, contra o limite de 5 da transação.
- Design da plataforma
  Tema escuro e moderno, na linha do Linear, mantendo a constelação do mapa.
  - [r] Proposta visual em alta fidelidade
    A base visual e a sequência de zoom do mapa estão aprovadas. Página do ticket, conversa de novo ticket e mudança de lugar ao editar aguardam revisão de Teodoro.
  - [x] ADR 0025 com a base visual aprovada
  - [x] Aplicar a base visual ao cabeçalho, ao painel lateral e à tela de times
  - [x] Aplicar a base visual aos cards do mapa
    Feito pela web, sem mexer em `packages/engine` nem em `packages/react`.
  - [ ] Card em nível "detalhe" no mapa
    O quinto nível dos quadros, para o card grande. O conteúdo do nó só recebe os quatro níveis atuais, sem a largura projetada; pede mudança em `packages/react` ou outra técnica.
  - [ ] Decidir se "cancelado" e "a fazer" têm cores diferentes no mapa
    Hoje os dois usam o mesmo cinza nos quadrados de resumo.
- Tickets no mapa (recorte da Fase 2)
  - [x] ADR 0024: modelo de ticket e importação por lista
  - [x] Banco: tabelas de ticket com RLS
  - [x] API de tickets com permissões por papel de projeto
  - [x] Cliente da API e interpretador da lista na web
  - [x] Tickets como nós abaixo do projeto no mapa
    Card escuro, com a cor do nó indicando a situação.
  - [x] Aplicar a migration de tickets no banco de desenvolvimento
  - [x] Tela de importação de lista com prévia
  - [x] Inserir em lote na importação
    Todos os tickets entram em uma única inserção; o número de comandos não cresce com a lista.
  - [/] Importar esta lista no projeto TreePM
    Falta repetir a importação com sessão real depois da correção do lote.
  - [ ] Página lateral do ticket com deslize e foco
    Abrir um ticket desliza o mapa, abre a página com detalhes e foca nele (IDEA-013). Inclui criar, editar, situação, pai e pessoas. Falta decidir o gesto que abre o ticket.
  - [ ] Serializar mudanças de pai simultâneas
    A detecção de ciclo vale por requisição. Duas mudanças ao mesmo tempo no mesmo projeto não se enxergam.
- IA da plataforma
  Novo ticket pela conversa e mudança de lugar ao editar (IDEA-005 e IDEA-014).
  - [ ] ADR da IA: modelo generativo, Jev, memória e mapa de conteúdo
    Decide o que a memória guarda, os provedores e as chaves. Depende das dúvidas 5, 9, 10 e 11 do blueprint.
  - [ ] Botão "Novo ticket" e painel de conversa
    A IA formata o texto e faz perguntas antes de procurar o lugar do ticket.
  - [ ] Busca do caminho do topo até a folha
    Testa em cada nível qual ramo se enquadra melhor e propõe onde criar o ticket.
  - [ ] Mudança de pai quando a edição muda a categoria
    Falta decidir se é automática ou confirmada ao salvar.
- Fase 2 completa: trabalho multidisciplinar
  - [ ] Contribuições por área no ticket
  - [ ] Critérios de aceite e regra de conclusão
  - [ ] Comentários globais e por área
  - [ ] Histórico visível do ticket
- Publicação
  - [ ] Instância de produção do Clerk
  - [ ] App e secrets na Fly
  - [ ] DNS de treepm.ai
  - [ ] Primeiro deploy e teste em produção
    Depende de autorização explícita de Teodoro.
