# ADR 0032 — Ligação com repositórios de código: GitHub primeiro

**Status:** Proposta. A direção foi pedida por Teodoro; o desenho abaixo é da coordenação e espera a leitura dele e as decisões listadas no fim. Nada foi implementado. **Data:** 2026-11-20.

## Contexto

Em 2026-11-20 Teodoro pediu: "a gente deveria conseguir plugar o GitHub e GitLab também, talvez mais algum outro, tipo Bitbucket, se for fácil de conectar todos eles. Mas principalmente o GitHub, a gente pode começar por ele e aí ter esse rastreio de branch e visibilidade geral do repositório a partir da plataforma" (IDEA-020). O pedido nasceu da conversa sobre hidratar tickets (IDEA-019): sem acesso ao código, a IA não sabe quanto um pedido envolve de cada área.

O que a documentação do GitHub diz e que pesa no desenho (lida em 2026-11-20):

- Um GitHub App é instalado em uma organização ou conta pessoal, com acesso a repositórios específicos, e age sem depender de um usuário.
- O app se autentica com um JWT assinado pela chave privada (validade de até 10 minutos) e troca por um token de instalação, que expira em 1 hora e pode ser restrito a repositórios e permissões no momento da criação.
- `GET …/branches`, `…/contents/{path}` e `…/git/trees/{sha}` pedem a permissão **Contents: read**; `GET …/pulls` pede **Pull requests: read**. Os eventos `push`, `create` e `delete` pedem Contents: read.
- Webhooks: assinatura no cabeçalho `X-Hub-Signature-256` (HMAC SHA-256, comparação em tempo constante), nome do evento em `X-GitHub-Event`, identificador da entrega em `X-GitHub-Delivery` (o mesmo em uma reentrega), resposta 2XX em até 10 segundos.
- Depois da instalação, o GitHub redireciona para a "Setup URL" com `installation_id`, e avisa: "you should not rely on the validity of the `installation_id` parameter". A recomendação é gerar um token do usuário que instalou e conferir que a instalação é dele.
- Limite de requisições de um token de instalação: 5.000 por hora, crescendo com o número de repositórios e de usuários até 12.500. Uma resposta `304` a uma requisição condicional autenticada não conta no limite.
- O GitHub recomenda webhooks em vez de consultas periódicas; quando a consulta é inevitável, requisições condicionais.
- O formato do token de instalação está mudando (anúncio de abril de 2026): não se deve supor um tamanho fixo.

Ficaram **sem confirmação** na leitura, e precisam ser conferidos antes da implementação: se a permissão Metadata: read é obrigatória ou automática; os campos dos eventos `installation` e `installation_repositories`; o limite da busca de código; se há reentrega automática de webhook que falhou.

Hoje o TreePM só existe no ambiente local. Sem endereço público, o GitHub não tem para onde mandar webhooks.

## Decisão proposta

### GitHub App, só leitura

A ligação é um **GitHub App** do TreePM, com as permissões mínimas de leitura: **Contents: read** e **Pull requests: read** (mais Metadata: read, se for exigida). Nenhuma permissão de escrita: o TreePM não cria branch, não comenta em PR e não muda nada no repositório.

Não se usa token pessoal nem OAuth app: o acesso tem que sobreviver à saída da pessoa que conectou e ficar restrito aos repositórios que a organização escolheu.

### Um contrato de provedor, uma implementação

A API conhece uma interface de provedor de repositórios (instalações, repositórios, branches, pull requests, leitura de arquivo). Só o adaptador do GitHub é implementado. GitLab e Bitbucket entram depois, pelo mesmo contrato; a ADR não promete que será fácil.

### Quem conecta o quê

- **Administrador da organização** conecta e desconecta o GitHub da organização (instala o app).
- **Administrador da organização ou gestor do projeto** liga repositórios da instalação a um projeto. Um projeto aceita vários repositórios.
- Quem vê o projeto vê as ligações dos tickets dele.

A instalação fica presa à organização do TreePM (o tenant do Clerk) em tabela própria com RLS. Ao voltar do GitHub pela Setup URL, a API **não confia** no `installation_id` recebido: confere, com um token do usuário que instalou, que a instalação é dele, e só então grava. Sem essa conferência, alguém poderia prender à própria organização a instalação de outra empresa.

### Primeira fatia: rastreio de branch e de pull request

- Um branch ou pull request se liga a um ticket quando o nome do branch ou o título do PR contém a chave do ticket (`TREEPM-12`, sem diferenciar maiúsculas).
- A página do ticket ganha a seção **Código**: branches e pull requests ligados, com nome, estado (aberto, mesclado, fechado), repositório e o link para o GitHub. O agrupador mostra a soma dos itens dele.
- O TreePM guarda só o necessário para mostrar isso: repositório, tipo, referência ou número, título, estado, endereço e data. **Nenhum conteúdo de arquivo é guardado.**
- Nada muda sozinho no ticket: a situação não acompanha o PR. (Mesclar o PR concluir o ticket é uma ideia razoável, mas fica fora.)

### Como os dados chegam

- **Enquanto não houver endereço público:** consulta sob demanda. Ao abrir um projeto ou um ticket, e por um botão "Atualizar", a API consulta o GitHub com requisições condicionais, que não gastam o limite quando nada mudou. Não há tarefa em segundo plano.
- **Com o deploy:** webhooks (`push`, `create`, `delete`, `pull_request`, `installation`, `installation_repositories`), validados pela assinatura, respondidos em menos de 10 segundos, com a entrega repetida reconhecida pelo `X-GitHub-Delivery`. Como a ordem de chegada não é garantida, cada evento serve de aviso: a API busca o estado atual do branch ou do PR em vez de confiar no que veio no evento.

A consulta sob demanda continua existindo depois dos webhooks, como reparo.

### Configuração e segredos

Variáveis opcionais na API, como as da IA: identificador do app, chave privada, segredo do webhook e credenciais de cliente (para a conferência da instalação). Sem elas a API sobe e a ligação fica desligada, e a web não mostra a seção. Token de instalação fica só em memória, pelo tempo de vida dele; nunca vai para o banco, para log nem para o navegador.

### Segunda fatia: a IA lê o código

Fica **fora da implementação desta ADR** e depende de autorização explícita de Teodoro. Código-fonte é outra categoria de dado: a ADR 0029 autorizou enviar à Anthropic e à TypeSafe texto de tickets e de conversas, não código de clientes. Quando for decidida, a proposta é: ligada por organização, desligada por padrão; a IA consulta árvore de arquivos e trechos sob demanda, durante a hidratação de um ticket; nada de código é guardado pelo TreePM.

## Fora desta ADR

- Qualquer escrita no repositório.
- GitLab e Bitbucket.
- Mudar a situação do ticket por evento do repositório.
- Estimativas a partir de PRs (IDEA-011).

## Consequências

- O ticket passa a mostrar onde o trabalho está acontecendo no código, sem a pessoa sair do mapa.
- Depende de convenção: branch ou PR sem a chave do ticket não aparece.
- Sem endereço público, a visão do repositório só é atualizada quando alguém abre a tela ou pede; pode estar atrasada.
- Mais uma integração com segredo de longa duração (a chave privada do app), que fica com a coordenação operacional.
- A conferência da instalação exige um passo de login do usuário no GitHub além da instalação do app.

## Decisões que esperam Teodoro

1. **Criar o GitHub App** (ou pedir ao grokbot): nome, permissões Contents: read e Pull requests: read, Setup URL do ambiente local, e guardar a chave privada e os segredos no arquivo de variáveis da API. É o que destrava a implementação.
2. **A primeira fatia como está descrita** (rastreio por chave no nome do branch e no título do PR, seção "Código", só leitura): confirmar ou ajustar.
3. **A IA lendo código:** sim ou não a enviar trechos de código dos repositórios ligados à Anthropic, e se o padrão é desligado por organização.
