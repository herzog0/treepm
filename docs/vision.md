# TreePM — Visão do produto

## Problema

Projetos não são listas. São árvores de trabalho e relações: quando as folhas de um ramo são concluídas, o trabalho representado pelo pai está concluído. Ferramentas lineares escondem contexto, dificultam enxergar o que depende do quê e tornam subtasks caras de manter. O volume e o tipo de trabalho produzido com IA tornam essa limitação ainda mais visível.

## Proposta

Uma plataforma cuja home `/` usa uma **constelação espacial Prezi** para viajar por regiões de trabalho. A experiência de **árvore top-down**, Lista e Kanban permanece completa em `/legacy`, sem que a antiga apresentação imponha sua composição à nova home.

### Visualização espacial `/`

- Hierarquia expressa por proximidade, tamanho decrescente e agregação, sem arestas top-down ou disposição Kanban. Cada pai organiza os filhos abaixo de si em regiões retangulares delimitadas, com slots uniformes e gerações menores; a home continua Prezi, não um grid plano.
- Zoom contínuo preserva o ponto mundial sob o cursor e acumula rolagens rápidas ou curtas sem perder microdeltas. Cards completos, títulos compactos, chips e dots/agregados aparecem conforme há espaço, com progresso acessível.
- Root e ramos próximos aparecem primeiro; zoom-in revela níveis menores. Clique simples abre detalhes; “Explorar ramo” no painel e breadcrumb controlam o mergulho, enquanto pan, fit/reset e movimento reduzido permanecem disponíveis.
- A navegação responde imediatamente ao clique e arraste após zoom. Arraste e wheel podem ser combinados para viajar pelo mapa sem esperar animações terminarem, preservando a âncora do cursor.
- `c`/`C` e o botão Cores alternam preenchimento pela cor de status com wash animado e texto legível, sem interferir em atalhos modificados ou edição.
- O mapa deriva posições uma vez por snapshot e limita o DOM à viewport/LOD, evitando uma coleção de mil cards completos.

### Visualização em árvore `/legacy`

- Raiz no topo, profundidade crescendo verticalmente e irmãos distribuídos horizontalmente por layout determinístico baseado nas formas visíveis.
- Cards familiares com identificador, título, múltiplos responsáveis, componentes, filhos e progresso acessível.
- Wheel altera a semântica no ponto sob o cursor; Shift + wheel faz pan horizontal e Ctrl/Meta + wheel ou controles alteram escala. Arraste esquerdo ou do meio faz pan no fundo e sobre cards após um threshold que preserva o clique.
- Conexões são objetos independentes, selecionáveis e estilizáveis individualmente.
- Hierarquia (`parentId` e arestas `hierarchy`) e dependências (`dependency`) são relações distintas. Criar ou remover dependência nunca muda o pai.

### Canvas com zoom semântico

O zoom não apenas escala os mesmos cards: o foco organiza a cena e o contexto progride entre cards completos, compactos, chips e quadradinhos de status. Ramificações laterais permanecem representadas por resumos com descendentes e progresso.

Zoom+ sobre outro card transfere atenção gradualmente até concluir a troca de foco; reverter o gesto restaura o contexto anterior. Clique define foco explicitamente, enquanto pan e wheel no fundo não escolhem tickets arbitrários. A seleção lógica é mantida durante transições, e só são desenhadas conexões cujos dois extremos estão representados.

### Tickets, componentes e responsáveis

- Subtickets formam hierarquia recursiva ilimitada, com `parentId` nullable e no máximo um pai.
- Todo ticket tem título, descrição, status `todo`, `in_progress` ou `done`, múltiplos `assigneeIds` (ou nenhum) e componentes livres.
- Cada componente tem seus próprios responsáveis. **Não existe owner único nem “reporter” obrigatório.**
- Somente folhas aceitam status manual. O progresso do pai deriva de todas as folhas descendentes, sem ponderação: `doneLeaves/totalLeaves`.
- Cinza significa nenhuma folha iniciada, verde todas concluídas e vermelho trabalho parcial/em andamento. Percentual e texto acompanham a cor.

### Classificação automática com IA (Jev)

Ao descrever um novo ticket, Jev pode sugerir categoria e posição na árvore. A integração vive somente na API e usa escolhas por nível com candidatos mínimos. A resposta preserva caminho, probabilidades e confiança.

A sugestão é sempre confirmável e nunca muta o projeto sozinha. Baixa confiança exige escolha manual. Sem credencial ou em erro externo, a interface identifica o fallback e não apresenta uma classificação inventada como sucesso.

## Atores e camadas

1. **Admin da plataforma:** backoffice inicial para observar projetos, tickets e usuários seed.
2. **Usuários:** criam e gerenciam projetos e tickets na árvore e nas visões complementares.
3. **Domínio compartilhado:** mantém regras puras consistentes entre API e interfaces.

## Decisões desta fatia

- Stack definida em `docs/architecture.md`: pnpm, TypeScript, React/Vite, XYFlow, Fastify, zod e TypeSafe AI SDK.
- Persistência local JSON atômica apenas para desenvolvimento; produção exige banco transacional.
- Exclusão de folha remove também suas conexões. Excluir pai exige confirmação recursiva explícita e remove toda a subárvore e as conexões incidentes.
- Ciclos, self-parent/self-dependency, duplicidade de dependência e IDs inexistentes são rejeitados.
- Autenticação e autorização não são simuladas: são a próxima etapa.

## Fora do escopo agora

Colaboração em tempo real, auditoria, undo, billing, integrações externas, deploy, permissões finas e operação multi-instância.
