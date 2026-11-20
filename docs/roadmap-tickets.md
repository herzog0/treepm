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
  - [x] Banco: tabelas de ticket com RLS
  - [x] API de tickets com permissões por papel de projeto
  - [x] Cliente da API e interpretador da lista na web
  - [x] Tickets como nós abaixo do projeto no mapa
    Com o card atual e a cor do projeto. A aparência definitiva vem com o design.
  - [/] Aplicar a migration de tickets no banco de desenvolvimento
    Pedido à coordenação operacional na issue #1. Até lá, o servidor local fica no código anterior aos tickets.
  - [ ] Painel do ticket: criar, editar, situação, pai e pessoas
  - [ ] Tela de importação de lista com prévia
  - [ ] Importar esta lista no projeto TreePM
  - [ ] Inserir em lote na importação
    Hoje a importação grava um ticket por vez na transação. Perto do limite de 500 itens, pode passar do tempo máximo da transação.
  - [ ] Serializar mudanças de pai simultâneas
    A detecção de ciclo vale por requisição. Duas mudanças ao mesmo tempo no mesmo projeto não se enxergam.
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
