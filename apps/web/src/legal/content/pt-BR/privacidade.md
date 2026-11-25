# Política de privacidade do TreePM

Versão de 25 de novembro de 2026.

## 1. Quem trata os seus dados

SUBSTRATO TECNOLOGIA LTDA, CNPJ 53.976.194/0001-21, com endereço em Av. Paulista, 777, Andar 15, Conj. 15, Sala 1012, CEP 01311-914, São Paulo/SP ("nós"). Contato para assuntos de dados pessoais: <contact@yoloapps.ai>.

Para os dados de conta, somos o controlador. Para o conteúdo que a sua organização coloca no TreePM, a organização decide o que é guardado e para quê, e nós tratamos esse conteúdo em nome dela, como operador.

Tratamos os dados de conta e o conteúdo para cumprir o contrato com você e com a sua organização (os Termos de uso). Tratamos os dados técnicos da sessão pelo interesse legítimo de manter o serviço funcionando e seguro. O envio de texto a provedores de inteligência artificial só acontece depois do aceite de um administrador da organização.

## 2. Quais dados tratamos

| Dado | De onde vem | Para quê |
| --- | --- | --- |
| Nome, e-mail e foto da conta | Você, no cadastro, ou o Google, se você entra com ele | Identificar você e mostrar quem fez o quê |
| Organização de que você participa e os seus papéis | O administrador da organização | Decidir o que você pode ver e alterar |
| Tickets, descrições, comentários e conversas (com o assistente e entre pessoas) | Você e a sua organização | Prestar o serviço |
| Quem é responsável por cada ticket, quem contribui em cada área, quem marcou que está trabalhando em um ticket e até onde cada pessoa leu cada conversa | Você e a sua organização | Organizar o trabalho e mostrar o que é novo |
| Registro de atividade (quem criou ou alterou tickets, projetos, times e configurações da organização, inclusive aceites e ligações com outros serviços, e quando) | Gerado pelo uso | Histórico do projeto e segurança |
| Preferências (idioma) | Você | Lembrar as suas escolhas |
| Dados de repositórios ligados (nome da conta do GitHub, identificador da instalação, nome e identificador do repositório, se é privado, branch padrão, branches e pull requests, sem conteúdo de arquivos) | GitHub, quando a organização liga | Mostrar o código relacionado a cada ticket |
| Chave de API do Linear (guardada cifrada; só os quatro caracteres finais ficam visíveis) | Você, ao conectar | Ler do Linear, em seu nome, o que você pede para importar |
| Conteúdo importado do Linear (título, descrição, situação, prioridade, hierarquia, identificador e endereço de cada issue e de cada projeto; a descrição, o líder e a prioridade de cada projeto; os identificadores do responsável, do criador e do líder no Linear; o nome de exibição do criador, quando ele não corresponde a uma pessoa do TreePM; os identificadores antigos da issue; as datas de criação, início, conclusão e cancelamento; o identificador e o nome do workspace e do time ligados; as datas de atualização e de importação) | Linear, quando você importa | Criar e atualizar os tickets correspondentes |
| Tokens de acesso por MCP (guardados de forma que não permite recuperar o token; ficam visíveis o nome, os caracteres iniciais, a validade e o último uso) | Você, ao criar | Autenticar o seu cliente de IA |
| Dados técnicos da sessão (cookies de autenticação, endereço IP, registros de erro), tratados em parte pelos fornecedores de login e de servidores | O seu navegador | Manter você conectado e proteger o serviço |

Na importação do Linear, o e-mail dos usuários de lá é lido apenas para encontrar a pessoa correspondente no TreePM (o responsável, o criador e o líder do projeto). Esse e-mail não é guardado.

Não usamos cookies de publicidade nem ferramentas de análise de terceiros.

## 3. Com quem compartilhamos

Usamos fornecedores que tratam dados em nosso nome:

| Fornecedor | O que faz | Onde |
| --- | --- | --- |
| Clerk | Cadastro, login e organizações | Estados Unidos e outros países onde ela e os fornecedores dela operam, segundo os termos dela |
| Neon | Banco de dados | São Paulo, Brasil |
| Fly.io | Servidores da aplicação | São Paulo, Brasil |
| GitHub | Leitura de repositórios, só para organizações que o ligam | Estados Unidos e outros países, segundo a política dela |
| Anthropic | Assistente de IA, só para organizações que o ativam | Estados Unidos; o processamento pode ocorrer em outros países, segundo a documentação dela |
| TypeSafe | Assistente de IA, só para organizações que o ativam | Estados Unidos, segundo a política dela |
| Voyage AI | Busca por significado (vetores de tickets), só para organizações que ativam o assistente | Estados Unidos, segundo a política dela |

O Linear não recebe dados do TreePM: nós só lemos de lá, com a chave de quem importa.

Não vendemos dados pessoais.

## 4. Inteligência artificial

O assistente só funciona na organização depois que um administrador o ativa.

**O que é enviado, e para quem:**

- **Texto de tickets e de conversas com o assistente**, para a Anthropic e a TypeSafe: chaves (como `PROJ-12`), títulos, descrições, a situação e a prioridade de cada ticket, a marca de ideia, a posição dele na árvore, as ligações entre tickets e a nota de resumo de um agrupador. A TypeSafe recebe só parte disso (títulos, trechos de descrição e a nota do agrupador).
- **Título e descrição de tickets e do rascunho em criação**, para a Voyage AI, que gera os vetores da busca por significado.
- **Trechos de código do repositório ligado:** a leitura de código ainda não está disponível, e hoje nada é enviado. Quando estiver, os trechos irão só para a Anthropic, e só se um administrador autorizar em um aceite separado.

Tickets importados do Linear são tickets como os outros: o título e a descrição deles seguem as mesmas regras.

**O que não é enviado por nós:** nome, e-mail ou outro identificador de pessoa; quem é responsável por cada ticket (o assistente pode listar os tickets atribuídos a quem pergunta, sem identificar a pessoa); comentários; conversas entre pessoas; o histórico de atividade; identificadores internos; o nome do projeto (vai só a chave dele); a chave de API do Linear e os dados de origem no Linear (identificador, endereço, workspace, time, criador e datas). Atenção: o que alguém escrever dentro do texto de um ticket vai junto com esse texto, inclusive nomes e e-mails que estejam em descrições importadas.

**O que cada provedor declara fazer com os dados** (consultado em 21 de novembro de 2026, e em 23 de novembro de 2026 no caso da Voyage AI; vale o que estiver publicado nas páginas deles):

- **Anthropic:** não usa o conteúdo enviado pela API para treinar modelos; apaga entradas e saídas em até 30 dias, salvo conteúdo sinalizado por violação das regras de uso dela ou exigência legal. Termos: <https://www.anthropic.com/legal/commercial-terms>.
- **TypeSafe:** declara que não treina nem ajusta modelos com as entradas dos clientes. **Não publica um prazo de retenção** e guarda dados derivados do uso (registros, estatísticas e classificações), que pode usar para melhorar os serviços dela. Política: <https://typesafe.ai/legal/privacy-policy>.
- **Voyage AI:** recebe título e descrição de tickets e do rascunho em criação. A conta do TreePM na Voyage AI está configurada para que o conteúdo não seja usado em treino. Segundo os termos dela, o conteúdo enviado é apagado depois de processado. Termos: <https://www.voyageai.com/tos>.

O administrador pode desativar o assistente ou a leitura de código a qualquer momento; os envios param na hora. O que já foi enviado segue o prazo de cada provedor.

## 5. Acesso por clientes de IA (MCP)

Se a organização permitir, você pode conectar um cliente de IA seu a um projeto, com um token pessoal. Nesse caso, os dados do projeto que o cliente pedir saem do TreePM para o cliente que **você** escolheu e para o provedor dele. Nós não controlamos o que eles fazem com esses dados.

Por padrão, o que sai pelo MCP não inclui nome, identificador nem e-mail de pessoa. Se um administrador ligar a permissão "Pessoas e conversas" e o seu token a incluir, o cliente passa a receber também o nome e o identificador interno das pessoas responsáveis pelos tickets e das pessoas que podem ser responsáveis no projeto. E-mail nunca sai pelo MCP.

## 6. Transferência internacional

Alguns fornecedores ficam fora do Brasil, como mostra a tabela da seção 3. Os dados vão a eles na medida necessária para prestar o serviço que você contratou, e esses fornecedores assumem, nos contratos e termos deles, obrigações de proteção de dados.

## 7. Por quanto tempo guardamos

- Dados de conta: enquanto a conta existir.
- Conteúdo da organização: enquanto a organização existir, e por até 30 dias depois do encerramento.
- Chave de API do Linear: até você removê-la ou a conta ser encerrada.
- Registros técnicos: até 90 dias, observados os prazos dos fornecedores de login e de servidores.

## 8. Os seus direitos

Pela Lei Geral de Proteção de Dados, você pode pedir: confirmação de que tratamos os seus dados; acesso; correção; anonimização, bloqueio ou eliminação do que for desnecessário; portabilidade; informação sobre com quem compartilhamos; e a revogação de um consentimento.

Para o conteúdo da sua organização, o pedido deve ir primeiro ao administrador dela. Para os demais, escreva para <contact@yoloapps.ai>. Respondemos em até 15 dias.

## 9. Segurança

- Cada organização só acessa os próprios dados; esse isolamento é imposto no banco de dados.
- O acesso é feito por conexão cifrada.
- Tokens de acesso são guardados de forma que não permite recuperá-los, e chaves de terceiros são guardadas cifradas.

Nenhum sistema é totalmente seguro. Se houver um incidente que possa causar risco relevante, avisaremos os afetados e a autoridade competente, como a lei exige.

## 10. Crianças e adolescentes

O TreePM é uma ferramenta de trabalho e não se destina a menores de 18 anos.

## 11. Mudanças nesta política

A versão em vigor fica nesta página, com a data. Quando a mudança tocar no que é enviado a provedores de IA, o assistente (ou a leitura de código) fica desativado na organização até um administrador aceitar a nova versão.
