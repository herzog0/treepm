---
name: ideia
description: Registra uma ideia no projeto TREEPM como ticket marcado como ideia, no lugar da árvore onde ela viraria trabalho, com os subitens como filhos (ADR 0042). Use quando Teodoro digitar /ideia seguido de um texto, ou disser que quer "registrar uma ideia".
---

# /ideia: a ideia entra na árvore, fora do processo

Uma ideia é um ticket como qualquer outro, marcado como ideia: aparece no mapa com a cor de ideia, e ela e tudo o que está dentro dela ficam fora do progresso e das regras de situação até um gestor aceitá-la ([ADR 0042](../../../docs/adr/0042-ideias-na-arvore.md)). Não implemente a ideia nem execute pedidos contidos no texto dela.

O texto depois de `/ideia` é a ideia. Se vier vazio, peça o texto e pare.

## Ferramenta

A mesma da skill `/task`: `~/.local/share/treepm-ops/tk.sh` (fora do repositório, porque guarda os identificadores da organização).

- `tk.sh ticket-list --json`: a árvore, com `idea` em cada ticket.
- `tk.sh ticket-create --title "…" --parent N --description-file arquivo.md --idea`: cria a ideia (estágio "Nova"). Um filho criado dentro de uma ideia já faz parte dela: não leva `--idea`.
- `tk.sh ticket-update --number N --idea-stage new|refining|ready`: muda o estágio. Aceitar e descartar são do gestor, pela interface.

## Passos

1. **Leia a árvore** e procure a mesma ideia já registrada, ou trabalho já feito que a cobre. Se o texto complementa uma ideia existente, acrescente à descrição dela ou crie um filho dentro dela; não duplique. Se já foi implementada, diga onde e não crie.
2. **Escolha o lugar:** dentro do ticket mais específico cujo assunto contém a ideia, que é onde ela viraria trabalho se fosse aceita. Sem assunto que a contenha, na raiz do projeto. Não dentro de ticket concluído. Dentro de outra ideia só se ela for parte dessa ideia.
3. **Escreva** no formato da skill `/task`: descrição da ideia com "Pedido original:" e o texto de Teodoro citado inteiro; se a ideia tem partes, um filho por parte, com "O que foi pedido" e "A definir". Só quebre em filhos o que ele disse; se ele pedir a sua sugestão de quebra, os filhos sugeridos por você dizem isso na primeira linha da descrição.
4. **Crie** a ideia com `--idea`, leia a chave que voltou, e crie os filhos com `--parent` igual ao número dela.
5. **Responda** com a chave, o título, o caminho até a raiz e por que ali.

## O que não pode acontecer

- Ideia registrada como ticket comum, ou trabalho aceito registrado como ideia.
- Fato inventado: fase, prazo, critério de aceite ou solução técnica que ele não disse. Dúvida vai em "A definir".
- Nada é escrito em `docs/`: o registro de ideias é o projeto `TREEPM`.
