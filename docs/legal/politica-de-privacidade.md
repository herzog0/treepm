# Política de privacidade do TreePM

> **RASCUNHO de 2026-11-21. Não publicado. Não revisado por advogado.**

Versão `[A PREENCHER: data de publicação]`.

## 1. Quem trata os seus dados

`[A PREENCHER: nome ou razão social, CPF ou CNPJ, endereço]` ("nós"). Contato para assuntos de dados pessoais: `[A PREENCHER: e-mail]`.

Para os dados de conta, somos o controlador. Para o conteúdo que a sua organização coloca no TreePM, a organização decide o que é guardado e para quê, e nós tratamos esse conteúdo em nome dela.

`[REVISÃO JURÍDICA: confirmar os papéis de controlador e operador e a base legal de cada tratamento abaixo, pela LGPD.]`

## 2. Quais dados tratamos

| Dado | De onde vem | Para quê |
| --- | --- | --- |
| Nome, e-mail e foto da conta | Você, no cadastro, ou o Google, se você entra com ele | Identificar você e mostrar quem fez o quê |
| Organização de que você participa e os seus papéis | O administrador da organização | Decidir o que você pode ver e alterar |
| Tickets, descrições e conversas com o assistente | Você e a sua organização | Prestar o serviço |
| Registro de atividade (quem criou ou alterou cada ticket, e quando) | Gerado pelo uso | Histórico do projeto e segurança |
| Preferências (idioma, aparência) | Você | Lembrar as suas escolhas |
| Dados de repositórios ligados (nome, branches e pull requests, sem conteúdo de arquivos) | GitHub, quando a organização liga | Mostrar o código relacionado a cada ticket |
| Tokens de acesso por MCP (guardados de forma que não permite recuperar o token) | Você, ao criar | Autenticar o seu cliente de IA |
| Dados técnicos da sessão (cookies de autenticação, endereço IP, registros de erro) | O seu navegador | Manter você conectado e proteger o serviço |

Não usamos cookies de publicidade nem ferramentas de análise de terceiros.

## 3. Com quem compartilhamos

Usamos fornecedores que tratam dados em nosso nome:

| Fornecedor | O que faz | Onde |
| --- | --- | --- |
| Clerk | Cadastro, login e organizações | `[A PREENCHER: confirmar região]` |
| Neon | Banco de dados | São Paulo |
| Fly.io | Servidores da aplicação | São Paulo |
| GitHub | Leitura de repositórios, só para organizações que o ligam | Estados Unidos |
| Anthropic | Assistente de IA, só para organizações que o ativam | Estados Unidos |
| TypeSafe | Assistente de IA, só para organizações que o ativam | Estados Unidos |

Não vendemos dados pessoais.

## 4. Inteligência artificial

O assistente só funciona na organização depois que um administrador o ativa.

**O que é enviado, e para quem:**

- **Texto de tickets e de conversas com o assistente**, para a Anthropic e a TypeSafe: títulos, descrições, a situação de cada ticket, a posição dele na árvore e as ligações entre tickets.
- **Trechos de código do repositório ligado**, só para a Anthropic, e só se um administrador autorizou a leitura de código em um aceite separado.

**O que não é enviado por nós:** nome, e-mail ou outro identificador de pessoa; quem é responsável por cada ticket; o histórico de atividade; identificadores internos. Atenção: o que alguém escrever dentro do texto de um ticket vai junto com esse texto.

**O que cada provedor declara fazer com os dados** (consultado em `[A PREENCHER: data da consulta]`; vale o que estiver publicado nas páginas deles):

- **Anthropic:** não usa o conteúdo enviado pela API para treinar modelos; apaga entradas e saídas em até 30 dias, salvo conteúdo sinalizado por violação das regras de uso dela ou exigência legal. Termos: <https://www.anthropic.com/legal/commercial-terms>.
- **TypeSafe:** declara que não treina nem ajusta modelos com as entradas dos clientes. **Não publica um prazo de retenção** e guarda dados derivados do uso (registros, estatísticas e classificações), que pode usar para melhorar os serviços dela. Política: <https://typesafe.ai/legal/privacy-policy>.

O administrador pode desativar o assistente ou a leitura de código a qualquer momento; os envios param na hora. O que já foi enviado segue o prazo de cada provedor.

## 5. Acesso por clientes de IA (MCP)

Se a organização permitir, você pode conectar um cliente de IA seu a um projeto, com um token pessoal de leitura. Nesse caso, os dados do projeto que o cliente pedir saem do TreePM para o cliente que **você** escolheu e para o provedor dele. Nós não controlamos o que eles fazem com esses dados.

## 6. Transferência internacional

Alguns fornecedores ficam fora do Brasil, principalmente nos Estados Unidos. `[REVISÃO JURÍDICA: mecanismo de transferência internacional aplicável pela LGPD.]`

## 7. Por quanto tempo guardamos

- Dados de conta: enquanto a conta existir.
- Conteúdo da organização: enquanto a organização existir, e por `[DECIDIR: prazo]` depois do encerramento.
- Registros técnicos: `[DECIDIR: prazo]`.

## 8. Os seus direitos

Pela Lei Geral de Proteção de Dados, você pode pedir: confirmação de que tratamos os seus dados; acesso; correção; anonimização, bloqueio ou eliminação do que for desnecessário; portabilidade; informação sobre com quem compartilhamos; e a revogação de um consentimento.

Para o conteúdo da sua organização, o pedido deve ir primeiro ao administrador dela. Para os demais, escreva para `[A PREENCHER: e-mail]`. `[DECIDIR: quem responde e em que prazo.]`

## 9. Segurança

- Cada organização só acessa os próprios dados; esse isolamento é imposto no banco de dados.
- O acesso é feito por conexão cifrada.
- Tokens de acesso são guardados de forma que não permite recuperá-los.

Nenhum sistema é totalmente seguro. Se houver um incidente que possa causar risco relevante, avisaremos os afetados e a autoridade competente, como a lei exige.

## 10. Crianças e adolescentes

O TreePM é uma ferramenta de trabalho e não se destina a menores de 18 anos.

## 11. Mudanças nesta política

A versão em vigor fica nesta página, com a data. Quando a mudança tocar no que é enviado a provedores de IA, o assistente (ou a leitura de código) fica desativado na organização até um administrador aceitar a nova versão.
