- Fechamento da Fase 1: organização segura
  Pendências para a Fase 1 cumprir a condição de saída do blueprint.
  - [/] Testar as telas de administração com sessão real
    Roteiro de dez passos na issue #1, a cargo da coordenação operacional. As telas só foram verificadas com cliente falso.
  - [ ] Criar o arquivo de variáveis locais da web no checkout principal
    Hoje a chave pública do Clerk é passada pelo ambiente do painel de desenvolvimento.
  - [ ] Sincronizar pessoas com o Clerk por webhook
    `people.active` só muda com sincronização. Exige ADR: verificação de assinatura, idempotência e eventos fora de ordem.
  - [ ] Exercitar o retorno do Google para conta sem organização
    Caminho da ADR 0020 que nunca foi testado com conta real.
  - [ ] Buscar `/api/me` uma única vez por sessão
    Hoje o indicador do cabeçalho e o Workspace fazem a mesma chamada.
  - [ ] Atualizar os papéis da pessoa depois de uma mudança de papel
    `me.roles` só muda ao recarregar a página.
- Design da plataforma
  Tema escuro e moderno, na linha do Linear, mantendo a constelação do mapa.
  - [/] Proposta visual em alta fidelidade
    Base visual, mapa com painel, ticket e tela de times.
  - [ ] ADR 0025 com a base visual aprovada
  - [ ] Aplicar a base visual ao cabeçalho, ao painel lateral e à tela de times
  - [ ] Aplicar a base visual aos cards do mapa
    Mexe em `packages/react`, que a ADR 0023 manteve intocado. Depende de aprovação explícita.
- Tickets no mapa (recorte da Fase 2)
  - [x] ADR 0024: modelo de ticket e importação por lista
  - [/] Banco: tabelas de ticket com RLS
  - [/] API de tickets com permissões por papel de projeto
  - [/] Cliente da API e interpretador da lista na web
  - [ ] Tickets como nós abaixo do projeto no mapa
  - [ ] Painel do ticket: criar, editar, situação, pai e pessoas
  - [ ] Tela de importação de lista com prévia
  - [ ] Importar esta lista no projeto TreePM
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
