---
name: task
description: Cria no projeto TREEPM um ticket com subtarefas a partir de um pedido em texto livre, no formato aprovado por Teodoro (pai com o pedido citado, um filho por parte, "A definir" separado), e escolhe o lugar certo na árvore. Use quando Teodoro digitar /task seguido de um pedido, ou pedir para "criar uma task" ou "registrar isso como ticket".
---

# /task: pedido vira ticket com subtarefas, no lugar certo do mapa

Paliativo enquanto a conversa de novo ticket da aplicação não está estável (TREEPM-209). Você cria os tickets pela ferramenta local, que age como o usuário de Teodoro.

O texto depois de `/task` é o pedido. Se vier vazio, peça o pedido e pare.

## Ferramenta

`~/.local/share/treepm-ops/tk.sh` (fica fora do repositório porque guarda os identificadores da organização):

- `tk.sh ticket-list --json`: todos os tickets, com `number`, `key`, `parentNumber`, `status`, `title`, `idea`.
- `tk.sh ticket-create --title "…" --parent N --description-file arquivo.md [--idea]`: cria e imprime a chave. Sem `--parent`, nasce na raiz do projeto.
- `tk.sh ticket-update --number N [--status todo|in_progress|done] [--title "…"] [--description-file arquivo.md]`.

Escreva as descrições em arquivos do diretório temporário da sessão, nunca dentro do repositório. A descrição de um ticket existente é lida pela ferramenta `get_ticket` do servidor MCP `treepm-treepm`, quando ele estiver conectado.

Se o atalho não existir, pare e avise: os identificadores não ficam no Git.

## Passos

1. **Leia a árvore.** `ticket-list --json`. Monte a hierarquia por `parentNumber`.
2. **Procure repetição.** Se já existe ticket que cobre o pedido, ou parte dele, diga qual e não crie de novo: proponha acrescentar um filho ao que existe.
3. **Escolha o lugar.** O pai é o ticket mais específico cujo assunto contém o pedido inteiro. Desça enquanto houver um filho que ainda contém tudo. Regras:
   - nunca dentro de um ticket concluído (`done`), a não ser que Teodoro peça;
   - nunca dentro de uma ideia (`idea`) se o pedido é trabalho aceito, e o contrário também;
   - não crie ticket agrupador nem mova tickets existentes para acomodar o novo;
   - se nenhum assunto contém o pedido, ele nasce na raiz;
   - se dois lugares servem igualmente, escolha o da família em andamento e diga qual era o outro.
4. **Quebre o pedido.** Uma parte por coisa distinguível que pode ser feita e conferida sozinha. Pedido de ação única (corrigir um defeito, trocar um texto) é um ticket só, sem filhos. No máximo 20 filhos.
5. **Escreva** no formato abaixo.
6. **Crie** o pai, leia a chave que voltou, e só então crie os filhos com `--parent` igual ao número do pai. Referências a outros tickets usam chaves que já existem: nunca adivinhe um número antes de criar.
7. **Responda** com uma tabela (chave, título), o lugar escolhido com o caminho até a raiz e, numa linha, por que ali. Não peça confirmação antes de criar: mover ou ajustar depois é barato.

Se Teodoro disser que é uma ideia ("ideia:", "uma ideia"), crie o pai e os filhos com `--idea`.

## Formato aprovado

**Pai.** Título curto que nomeia o pedido. Descrição:

```markdown
Pedido original:

> o texto de Teodoro, inteiro e com as palavras dele, sem corrigir nem resumir
```

Depois da citação, no máximo uma frase dizendo em quantas partes foi quebrado.

**Cada filho.** Título que nomeia a parte. Descrição:

```markdown
O que foi pedido:

- o que Teodoro disse sobre esta parte, com as palavras dele ou muito perto delas

A definir:

- perguntas que o pedido deixa abertas para esta parte
```

A seção "A definir" some quando não há pergunta aberta.

## O que não pode acontecer

- Nada do que ele disse some: toda frase do pedido aparece na citação do pai e em pelo menos um filho.
- Nada que ele não disse entra como fato: nem fase, nem critério de aceite, nem prazo, nem solução técnica. Dúvida vai em "A definir".
- Nenhum ticket cita outro que não existe.
- Nomes de pessoas, e-mails e segredos não entram em título nem descrição.

## Depois

A situação dos tickets é da coordenação: o pai passa a `in_progress` quando o primeiro filho começa, e um ticket só vira `done` depois de o PR correspondente estar mesclado.
