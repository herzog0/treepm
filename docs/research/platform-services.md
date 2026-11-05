# Clerk e Jev — fundamentos para o blueprint

**Verificado em:** 2026-11-05. **Status:** pesquisa de capacidades e propostas; nenhuma integração foi implementada. Este documento não substitui uma revisão de contrato, disponibilidade ou plano comercial no início da implementação.

## Como ler

Os blocos **Confirmado** descrevem documentação oficial. Os blocos **Proposta TreePM** são decisões recomendadas para o produto, ainda sujeitas ao blueprint e à validação. A engine permanece independente de autenticação, tickets e fornecedores de IA.

## Clerk: identidade, organização e acesso

### Organização como contexto de tenant

**Confirmado.** Clerk Organizations agrupa usuários, memberships, papéis e permissões. Uma pessoa pode participar de várias organizações; a organização ativa fornece o contexto da sessão. Isso atende a um SaaS B2B com um conjunto compartilhado de identidades. A documentação também orienta armazenar o ID da organização junto aos recursos do banco para filtrá-los pelo contexto ativo. [Organizations](https://clerk.com/docs/guides/organizations/overview), [Multi-tenant architecture](https://clerk.com/docs/guides/how-clerk-works/multi-tenant-architecture).

**Proposta TreePM.** Um tenant empresarial corresponde a uma Clerk Organization, ligado por ID externo estável a um registro interno de organização. Projetos, equipes, áreas, tickets, anexos, comentários, convites de produto, buscas e jobs pertencem explicitamente ao tenant. Equipes internas não viram organizações separadas: Engenharia e Design precisam colaborar no mesmo ticket sem cruzar uma fronteira de tenant.

**Proposta TreePM.** Toda leitura e escrita da API valida identidade, organização e autorização sobre o recurso. O ID solicitado na URL ou enviado pelo frontend nunca basta para conceder acesso. O isolamento também cobre caches, eventos em tempo real, exports, índices semânticos, referências cruzadas, anexos e contexto enviado à IA. Clerk não define essas regras de domínio nem particiona automaticamente nossos dados.

### Papéis e administração

**Confirmado.** Os papéis padrão são `org:admin` e `org:member`. Existem papéis e permissões personalizados; permissões de sistema do Clerk não entram nos session claims, e sua documentação orienta usar permissões customizadas para verificações de aplicação no servidor. Recursos avançados de RBAC em produção dependem do plano/add-on. [Roles and Permissions](https://clerk.com/docs/guides/organizations/control-access/roles-and-permissions).

**Proposta TreePM.** Distinguir administração da organização, administração de time, gestão de projeto, contribuição e leitura. Um responsável por ticket não ganha privilégios administrativos por estar assinalado. Papéis organizacionais amplos podem aproveitar Clerk; acesso por projeto, participação por área, escopo de convidado e permissões sobre comentários pertencem ao domínio da aplicação. A interface oculta ações indisponíveis, mas a API aplica a mesma política. A referência oficial de verificações de servidor está em [Authorization checks para Fastify](https://clerk.com/docs/fastify/guides/secure/authorization-checks); a escolha de framework da API futura continua aberta.

### Provisionamento, mudanças de acesso e sincronização

**Confirmado.** Clerk oferece eventos para sincronizar dados. Webhooks são assíncronos, podem repetir e chegar fora de ordem; retries não garantem sucesso definitivo. O payload precisa ser verificado antes de ser aceito. Onboarding síncrono não deve depender de um webhook já ter chegado. [Webhooks overview](https://clerk.com/docs/guides/development/webhooks/overview).

**Confirmado.** Sincronização local é eventualmente consistente. Para apresentar nomes e avatares de outros participantes, a documentação admite uma projeção local, evitando consultar a Backend API em toda leitura. [Sync Clerk data to your app](https://clerk.com/docs/guides/development/webhooks/syncing).

**Proposta TreePM.** Manter uma projeção mínima dos usuários e memberships necessários ao produto, com processamento idempotente, controle de versão temporal e reconciliação. Acesso revogado invalida canais, caches e jobs pertinentes. Histórico de autoria é preservado conforme a política de retenção: remover uma pessoa da equipe não apaga suas decisões anteriores nem deixa tarefas sem contexto. A política de privacidade e exclusão de dados ainda precisa ser definida.

**Confirmado.** Abas diferentes podem ter organizações ativas diferentes. A documentação alerta que o cookie de sessão é compartilhado e recomenda obter o token adequado à aba para chamadas em background. [Active Organizations em múltiplas abas](https://clerk.com/docs/guides/organizations/overview).

**Proposta TreePM.** Trocar organização limpa o estado derivado do tenant anterior: seleção, resultados de busca, filtros salvos carregados, conexão em tempo real e contexto de IA. A aplicação deve validar a associação entre contexto da requisição e recurso, inclusive em várias abas.

### Limites que influenciam a adoção

**Confirmado em 2026-11-05.** A configuração documentada parte de cinco membros por organização; sem o B2B Authentication add-on, o limite configurável é de vinte, enquanto o add-on permite organizações sem esse limite. Papéis personalizados em produção também exigem o add-on; a página de papéis documenta até dez papéis customizados por instância antes de contato com suporte. Esses números devem ser revalidados antes de contratar ou prometer capacidade. [Configure Organizations](https://clerk.com/docs/guides/organizations/configure), [Roles and Permissions](https://clerk.com/docs/guides/organizations/control-access/roles-and-permissions).

**Decisão em aberto.** A árvore privada diária do desenvolvedor não obriga a ativar Personal Accounts do Clerk: ela pode ser um espaço privado dentro de um tenant. Unificar trabalho pessoal de vários tenants é outra capacidade e precisa de uma política explícita, sem compartilhar conteúdo entre empresas por padrão. Clerk permite configurar membership obrigatória ou opcional. [Configure Organizations](https://clerk.com/docs/guides/organizations/configure).

## Jev: decisões estruturadas, com código em controle

### Identidade do serviço e escopo confirmado

**Confirmado.** O Jev relevante é o modelo da TypeSafe AI: o site da empresa aponta para `docs.typesafe.ai`. Na documentação oficial, Jev recebe estado e perguntas tipadas e devolve decisões estruturadas; não é um gerador de texto. `Choice` seleciona opções fornecidas, `Score` avalia uma rubrica e `Noul` estima uma resposta sim/não. [TypeSafe AI](https://typesafe.ai/), [Introduction](https://docs.typesafe.ai/introduction).

**Evidência local.** O checkpoint Git `33c4702`, em `apps/api/src/classifier.ts` e seu manifest, usava `@typesafe-ai/sdk` 0.7.0, `TypeSafeClient.systemOne`, `choice` e `jev-latest`. A integração foi removida no reinício da base. Essa referência identifica o serviço desejado; não demonstra que a antiga implementação ou seus limites devam voltar.

**Proposta TreePM.** Criar fronteiras separadas para busca, decisões e geração de conteúdo. Jev pode avaliar candidatos ou escolher um ramo. Melhorar descrições, gerar títulos, sugerir um nome novo de categoria e produzir uma síntese em linguagem natural exigem uma capacidade generativa distinta. Não atribuir embeddings, índice vetorial, geração de texto ou orquestração automática de ferramentas ao Jev sem documentação específica.

### Classificação pela árvore

**Confirmado.** O cookbook oficial apresenta classificação hierárquica perguntando sobre filhos de cada nó. Explica tanto a escolha gulosa quanto beam search, que mantém alguns caminhos candidatos para reduzir o impacto de um erro inicial. É um padrão composto em código, não uma função nativa que reorganiza o banco. [Hierarchical classification](https://docs.typesafe.ai/cookbooks/hierarchical_classification).

**Proposta TreePM.** O fluxo da IDEA-005 pode consultar irmãos e contexto do caminho, oferecer “permanecer neste pai” e “nenhuma categoria adequada” e apresentar alternativas ao usuário. Orçamento de candidatos, latência e profundidade deve ser explícito; nunca truncar um ramo silenciosamente. Uma categoria nova passa por proposta de conteúdo e validação de domínio antes de ser criada. Nenhuma resposta do modelo altera por si só `parentId`, pessoas assinaladas ou permissões.

### Incerteza, revisão e avaliação

**Confirmado.** Em `Choice` e `Score`, `confidence` resume a distribuição das probabilidades; não significa simplesmente a probabilidade de a resposta estar correta. A documentação diferencia essas medidas e recomenda definir thresholds conforme o domínio e as consequências da ação. `Noul` não retorna um campo separado de confiança. [Confidence](https://docs.typesafe.ai/confidence).

**Proposta TreePM.** Começar com sugestões revisáveis e comparação entre candidatos. Medir aceitação, correções, abstinência, precisão por ramo e custo/latência com exemplos do tenant. Registrar versão do fluxo e da decisão, sem expor conteúdo privado em logs. Busca e triagem continuam disponíveis por regras e seleção manual quando o serviço falha. O julgamento da IA não substitui regras determinísticas de integridade ou autorização.

## Consequências para o blueprint

1. **Clerk cuida da identidade e do contexto organizacional; TreePM cuida do domínio e do isolamento de seus recursos.** Times, áreas e múltiplas contribuições ao mesmo ticket pertencem à aplicação.
2. **Busca semântica é uma capacidade própria.** Recuperar candidatos autorizados antes de avaliá-los com IA; uma decisão do Jev pode ajudar a ordenar ou classificar resultados, mas não substitui a infraestrutura de busca.
3. **Conteúdo gerado e decisões estruturadas têm contratos distintos.** Os dois podem cooperar em rascunhos de tickets, classificação, preparação de stand-up e avaliação de bloqueios, sempre com escopo de dados e ação definidos.
4. **Pontos a fechar antes de implementar:** política de espaço privado, acesso de convidados e áreas, propagação de revogação, retenção e envio de dados a fornecedores, plano Clerk compatível com o público-alvo e avaliação do Jev com casos reais.
