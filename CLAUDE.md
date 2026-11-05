# Instruções do projeto

## Sincronização de instruções

- Toda instrução adicionada ou alterada em `CLAUDE.md` deve ser adicionada ou alterada também em `AGENTS.md` na mesma interação, inclusive esta regra de sincronização.

## Registro de ideias

- Sempre que o usuário apresentar uma ideia concreta para o projeto, registre-a em `docs/ideas.yaml` na mesma interação. Se a ideia já existir, atualize-a em vez de criar uma duplicata.
- Use IDs sequenciais e estáveis no formato `IDEA-NNN`, datas no formato `YYYY-MM-DD` e preencha os campos seguindo as entradas existentes.
- Preserve o ID e a data original de cada ideia. Represente relações pelo ID da outra ideia, com um tipo como `related_to`, `depends_on` ou `refines`.
- Não transforme discussões apenas sobre o formato ou o processo de registro em novas ideias.
