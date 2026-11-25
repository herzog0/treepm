# ADR 0039 — Termos de uso, política de privacidade e aceite por organização

**Status:** Texto aprovado por Teodoro em 2026-11-24 e publicado em 2026-11-25 (PR #116); o aceite passou à versão `2026-11-25`. Nasceu como proposta da coordenação, em 2026-11-21, para cumprir a condição que Teodoro pôs ao autorizar o envio de código à Anthropic. O mecanismo abaixo pode ser implementado; **o texto dos dois documentos só é publicado depois de ele aprovar**, porque é um compromisso em nome dele. **Data:** 2026-11-21.

Completa a "Segunda fatia" da [ADR 0032](0032-ligacao-com-repositorios-github-primeiro.md), que deixou para uma ADR própria o texto, quem aceita e onde o aceite fica guardado.

## Contexto

Em 2026-11-20 Teodoro autorizou a IA a ler trechos de código com uma condição: "coloca isso como algo a ser aceito pelo usuário em termos de uso ou privacidade do site". Em 2026-11-21 confirmou ("Sim pro código fonte") e autorizou a primeira publicação na Fly.

O TreePM não tem termos de uso, política de privacidade nem registro de aceite. Hoje, com as chaves configuradas, a IA fica ligada para toda organização: o texto de tickets e de conversas vai à Anthropic e à TypeSafe sem que ninguém da organização tenha aceitado nada. Em desenvolvimento isso só alcança as organizações de teste. Em produção, com cadastro aberto, alcançaria qualquer organização, e por isso a coordenação pediu que a produção comece com cadastro restrito.

O que foi conferido nas páginas dos provedores em 2026-11-21 (não é conhecimento de memória):

- **Clerk** tem a opção "Require express consent to legal documents", na página Legal do painel: põe uma caixa de aceite no cadastro e grava `legalAcceptedAt` no usuário. Não há nada equivalente para a organização. O que acontece com quem se cadastrou antes de a opção ser ligada não está documentado. ([guia](https://clerk.com/docs/guides/secure/legal-compliance))
- **Anthropic (API):** os termos comerciais dizem que ela não treina modelos com o conteúdo do cliente; entradas e saídas da API são apagadas em até 30 dias, com exceções (conteúdo sinalizado por violação de uso, exigência legal); pelo adendo de tratamento de dados, o cliente é o controlador e ela é a operadora. ([termos](https://www.anthropic.com/legal/commercial-terms), [retenção](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data), [adendo](https://www.anthropic.com/legal/data-processing-addendum))
- **TypeSafe:** a política diz que não treina nem ajusta modelos com as entradas do cliente; **não publica prazo de retenção** ("pelo tempo necessário"); guarda e pode usar sem restrição a telemetria que deriva dos dados (registros, resumos estatísticos, classificações); os serviços ficam nos Estados Unidos; é operadora pelo adendo dela. ([política](https://typesafe.ai/legal/privacy-policy), [contrato](https://typesafe.ai/legal/mca), [adendo](https://typesafe.ai/legal/data-processing))

## Decisão

### Dois documentos públicos

- **Termos de uso** e **Política de privacidade**, em páginas do próprio site, abertas sem login, com versão e data.
- Nos três idiomas da interface; a versão em português do Brasil é a que vale em caso de diferença.
- O rascunho fica em `docs/legal/`, escrito pela coordenação. **Publicar depende da aprovação de Teodoro** e dos dados que só ele tem: nome e identificação de quem responde pelo serviço e o contato para pedidos sobre dados pessoais.

### O que a política de privacidade precisa dizer sobre a IA

- Quais dados saem do TreePM e para quem: texto de tickets e de conversas com o assistente, para a Anthropic e a TypeSafe; trechos de código do repositório ligado, só para a Anthropic e só com a leitura de código ligada pela organização.
- O que não sai: nome, e-mail ou identificador de pessoa, e ids internos.
- O que cada provedor declara fazer com os dados, com o endereço da página dele e a data da consulta, sem prometer em nome dele além do que está publicado. No caso da TypeSafe, dizer que ela não publica prazo de retenção e que guarda telemetria derivada.
- Que o acesso por MCP (ADR 0038), quando a organização o liga, entrega dados do projeto ao cliente de IA que a própria pessoa escolheu.

### Aceite da pessoa, no cadastro

- A opção de aceite do Clerk é ligada na instância de produção pela coordenação operacional, apontando para as duas páginas. O registro é o `legalAcceptedAt` do Clerk; o TreePM não o duplica.

### Aceite da organização, para a IA *(escolha da coordenação)*

Dois aceites separados, dados por um administrador da organização e guardados no banco do TreePM, com a versão do documento, quem aceitou e quando:

1. **Assistente de IA:** autoriza enviar texto de tickets e de conversas à Anthropic e à TypeSafe. Sem ele, nenhuma função de IA funciona para a organização: conversa de novo ticket, procura do lugar, resumos, escrita na descrição e pergunta sobre o projeto.
2. **Leitura de código pela IA:** autoriza enviar trechos de código à Anthropic. Só é oferecido com o GitHub ligado e com o primeiro aceite dado. É o que a condição de Teodoro pede.

Regras:

- Cada aceite pode ser retirado pelo administrador a qualquer momento; os envios param na requisição seguinte. O que já foi enviado segue o prazo de cada provedor.
- Quando a versão do documento muda no que diz sobre a IA, o aceite precisa ser dado de novo; até lá, a função correspondente fica desligada para a organização.
- Aceitar e retirar gravam evento de atividade.
- A conferência fica em um lugar só na API, antes de qualquer chamada a provedor.

**Efeito sobre o que existe:** quando isso entrar, o assistente fica desligado em toda organização que ainda não aceitou, inclusive as de desenvolvimento, até um administrador aceitar.

### Na interface

- Em Configurações da organização, a seção "IA e privacidade": os dois aceites, com o link para os documentos, quem aceitou e quando, e o botão de retirar.
- Para quem não é administrador, onde hoje aparece "assistente desligado", o texto diz que um administrador precisa ativá-lo.
- Rodapé ou menu com os links para os dois documentos.
- Textos nos três idiomas (ADR 0035).

### Banco (migration própria)

- Tabela de aceites da organização: organização, tipo (`assistant` ou `code_reading`), versão do documento, pessoa que aceitou, data do aceite e data da retirada; isolamento por organização como as outras tabelas.

## Ordem

1. Rascunho dos dois documentos em `docs/legal/`, para Teodoro ler.
2. Mecanismo: tabela, conferência na API, tela dos aceites e páginas públicas (com o texto em rascunho marcado como tal enquanto não for aprovado).
3. Publicar o texto aprovado e ligar o aceite do Clerk em produção.
4. Só então: abrir o cadastro em produção e implementar a leitura de código (`TREEPM-82`).

Tudo no `TREEPM-81`, com um filho por fatia quando começar.

## Alternativas descartadas

- **Só uma frase nos termos, aceita no cadastro.** Cumpriria a letra do pedido, mas quem liga o GitHub é o administrador da organização, e o código é da organização, não de cada pessoa que se cadastra.
- **Um aceite só para tudo.** Código é outra categoria de dado (ADR 0032); a organização pode querer o assistente sem deixar a IA ler o repositório.
- **Guardar o aceite só no Clerk.** O Clerk não tem aceite por organização.

## Em aberto

1. O texto dos dois documentos e os dados de quem responde pelo serviço (Teodoro).
2. Pedidos de titulares de dados (acesso, correção, exclusão): por onde chegam e quem responde.
3. Se a telemetria que a TypeSafe guarda sem prazo é aceitável para clientes, ou se vale pedir a ela o contrato sem retenção que ela oferece.
4. Usuários cadastrados no Clerk antes de o aceite ser ligado.

## Detalhes fixados antes de implementar o mecanismo (2026-11-22, `TREEPM-90`)

Teodoro mandou seguir com o mecanismo em 2026-11-22 ("Pode seguir assim"). O texto dos documentos continua esperando a aprovação dele. O que faltava decidir para a implementação começar, tudo escolha da coordenação:

- **Versão aceita enquanto o texto é rascunho.** A versão do que a organização aceita é uma constante do domínio. Enquanto o texto não for aprovado ela vale `rascunho-1`. Quando o texto aprovado for publicado a constante muda, e pela regra já decidida todo aceite dado ao rascunho deixa de valer: o administrador aceita de novo, agora o texto de verdade.
- **O que a tela mostra.** A seção de aceite diz ela mesma, em texto do catálogo, o que sai, para quem e o que não sai, e traz os links `/termos` e `/privacidade`. Essas duas páginas só existem no PR #116, que continua travado pelo teste até o texto ser aprovado; até lá os links não levam a lugar nenhum fora desse PR. O mecanismo não mexe nesse teste.
- **Onde a conferência fica.** Em um ponto só da API, antes de qualquer uso de uma porta de provedor de IA, com um teste que enumera todas as portas e todos os lugares que as usam, para uma função nova não nascer sem a conferência.
- **Ferramentas de linha de comando.** O verificador de provedores usa dados fictícios e não passa pela conferência. A ferramenta de medição da procura lê tickets de uma organização de verdade e passa: sem o aceite do assistente, ela recusa.
- **Ninguém aceita em nome de um administrador.** Não há semente, comando nem inserção direta no banco que grave aceite em dados reais. Quando o mecanismo entrar no `main`, o assistente fica desligado em toda organização, inclusive as de desenvolvimento, até um administrador aceitar em Configurações.
- **O acesso por MCP** (ADR 0038) não depende destes aceites: tem a chave própria da organização e não envia nada a provedor de IA.
- **Banco:** migration `0013`.

## Como ficou o mecanismo (PR #126, 2026-11-22)

- **Banco:** `organization_consents` (migration `0013`). Cada aceitar cria uma linha; retirar preenche quem e quando na linha em vigor; um índice único parcial garante no máximo uma linha em vigor por organização e tipo. O papel da aplicação lê, insere e só atualiza as duas colunas da retirada: não apaga nem reescreve o que foi aceito.
- **Rotas:** `GET /api/organization/ai-consent` (qualquer membro), `PUT` e `DELETE /api/organization/ai-consent/:kind` (administrador). O `PUT` leva a versão que a pessoa viu; se não for a atual, 409 `consent_version_changed`. `code_reading` sem `assistant` em vigor ou sem GitHub ligado é recusado com 409. Retirar `assistant` retira `code_reading` na mesma transação.
- **A conferência:** `AssistantGate` (`apps/api/src/assistant/assistant-gate.ts`) é o único lugar que injeta as sete portas de provedor. Uma rota só recebe um provedor depois de, nesta ordem, o assistente estar configurado no servidor (503 `assistant_not_configured`) e a organização ter o aceite em vigor (403 `assistant_consent_required`). Um teste enumera as portas e falha se algo as injetar ou usar por fora. Não há tarefa de IA em segundo plano na API: todo caminho passa por uma requisição.
- **Também passam pela conferência** as rotas que leem e escrevem à mão o texto "O que entra aqui" do ticket: já respondiam como as demais rotas do assistente quando ele estava desligado, e continuam assim sem o aceite.
- **Web:** `/api/me` passou a devolver `assistant: { configured, consent, enabled }`. A seção "IA e privacidade" fica em Configurações e só aparece com o assistente configurado no servidor. Onde havia mensagem de assistente desligado, o texto agora diz que um administrador precisa ativá-lo.
- **Linha de comando:** a medição da procura confere o aceite da organização e recusa sem ele; o verificador de provedores, com dados fictícios, não.
- **Leitura de código:** a função `requireCodeReadingConsent` existe e está testada, sem consumidor ainda (`TREEPM-82`).
- **Não foi exercitado** com sessão real no navegador. As páginas `/termos` e `/privacidade` continuam só no PR #116.

## Publicação (2026-11-25)

- Teodoro aprovou os textos em 2026-11-24, informou os dados da empresa (responsável, endereço, e-mail, público, foro e prazo de resposta a titulares) e decidiu publicar sem revisão jurídica. Em 2026-11-25 aceitou as propostas da coordenação para o que faltava: até 30 dias de guarda depois do encerramento, registros técnicos por até 90 dias, o mesmo e-mail para pedidos de titulares e serviço sem cobrança por ora.
- As páginas `/termos` e `/privacidade` entraram pelo PR #116. O texto vale só em português do Brasil.
- O texto publicado acrescentou ao rascunho o que o produto ganhou desde então: importação do Linear (chave cifrada por pessoa, o que fica guardado, o que não vai à IA), comentários e conversas entre pessoas na lista de dados, e o alcance de escrita do MCP.
- `AI_CONSENT_VERSION` passou de `rascunho-3` para `2026-11-25`. Todo aceite dado ao rascunho deixou de valer: o assistente fica desligado em cada organização até um administrador aceitar de novo.
- Ficam como tickets, filhos de `TREEPM-87`: revisão por advogado (`TREEPM-456`), leitura do adendo da Voyage AI (`TREEPM-457`), mecanismo para os prazos de 30 e 90 dias (`TREEPM-458`) e tradução (`TREEPM-459`).
