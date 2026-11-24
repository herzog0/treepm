# 0057 — Pessoas de teste e "entrar como", só para pessoa de teste

- **Data:** 2026-11-24
- **Situação:** pedido de Teodoro em 2026-11-24 (`TREEPM-404`); detalhe e limite decididos pela coordenação por delegação, reversíveis.

## Contexto

As conversas em níveis ([ADR 0055](0055-barra-lateral-fixa-e-conversas-em-niveis.md)) só se testam com mais de uma pessoa: marcar alguém, ver a thread do lado dela, ver o que o convidado enxerga. A organização de teste tem uma pessoa só. Teodoro pediu "alguns usuários de teste falsos para eu poder mencionar" e, nas Configurações, "uma opção de administrador para eu poder ver as pessoas que tem na plataforma e um botão de impersonate para eu entrar como se fosse aquela pessoa e ver as respostas e tudo mais".

Uma pessoa hoje nasce no primeiro acesso autenticado pelo Clerk ([ADR 0019](0019-clerk-organizacao-como-tenant.md)); o banco guarda o identificador do Clerk como texto, sem conferi-lo. Não existe modo de sessão de desenvolvimento nem distinção de ambiente no código.

A ADR 0055 promete que nenhum papel, nem administrador, lê conversa em que não está. Um "entrar como" sem limite desfaria essa promessa para a plataforma inteira.

## Decisão

1. **Pessoa de teste é uma pessoa marcada.** A tabela de pessoas ganha a marca `is_test`. Uma pessoa de teste existe só no banco do TreePM, com um identificador sintético no lugar do usuário do Clerk e um e-mail em domínio inválido; não consegue entrar por conta própria. Para todo o resto ela é uma pessoa comum, com papel de membro: aparece nas listas, pode ser posta em times e projetos, marcada em conversas e responsável por ticket. Em toda lista ela leva o selo "teste".
2. **Só administrador cria e desativa pessoa de teste,** nas Configurações, seção nova "Pessoas", que também lista todas as pessoas da organização (nome, e-mail, papel, ativa ou não).
3. **"Entrar como" vale só para pessoa de teste.** Um administrador escolhe uma pessoa de teste ativa da própria organização e passa a ver a aplicação como ela. Pessoa de verdade não tem o botão, e o servidor recusa a tentativa. A regra é do servidor, não da tela.
4. **Como funciona:** a sessão continua sendo a do administrador no Clerk; cada requisição leva o pedido de agir como a pessoa escolhida, e o servidor, depois de conferir (quem pede é administrador; a outra é de teste, ativa e da mesma organização), monta a identidade da pessoa de teste, com papel de membro. Vale por aba do navegador e acaba em "Voltar a ser eu" ou ao fechar a aba.
5. **Enquanto dura,** uma faixa fixa diz "Você está vendo como … (teste)". Como a identidade é de membro, as ações de administrador ficam naturalmente fora: aceite de IA, ligação com o GitHub, chave do MCP, criar pessoa de teste. Criar chave de acesso pessoal também é recusado enquanto se age como outra pessoa.
6. **Registro:** o que a pessoa de teste faz fica registrado como dela; o uso do "entrar como" vai ao log do servidor com os dois identificadores, sem conteúdo.

## Fora deste recorte

- **"Entrar como" pessoa de verdade** (suporte). Seria uma exceção à privacidade das conversas, com texto no documento de privacidade e trilha de auditoria; é decisão de Teodoro e não é recomendada agora.
- Pessoa de teste com login próprio no Clerk.
- Apagar pessoa de teste e o que ela escreveu: nesta versão ela é desativada.

## Consequências

- Dá para testar conversas entre pessoas com uma conta só.
- Existe agora um caminho em que uma requisição age em nome de outra pessoa; ele depende de três conferências do servidor e é o ponto que mais pede teste nesta mudança.
- Pessoas de teste aparecem misturadas às de verdade nas listas da organização, distinguidas pelo selo.
- As mensagens de uma pessoa de teste vão ao provedor de IA como as de qualquer pessoa da organização; são texto escrito por um administrador.

## Como ficou (2026-11-24)

Numa mudança só, com a migration `0034_persons_is_test`.

- **Banco:** `people.is_test`, gravada só na inserção (o papel da aplicação não tem `UPDATE` nela nem no identificador do Clerk); a marca é amarrada por restrição ao identificador sintético e ao papel de membro. `ticket_comments` ganha quem agiu de verdade.
- **Servidor:** o cabeçalho `X-TreePM-Act-As` é lido num lugar só e conferido ao carregar a identidade da requisição, antes de qualquer efeito e de novo a cada transação. Qualquer falha responde o mesmo 403 e fica no log, só com identificadores e o motivo. Requisição por chave de acesso ou pelo MCP com o cabeçalho é recusada. Um teste percorre todas as rotas da API provando que, com alvo que não é pessoa de teste, nada é lido nem escrito.
- **Rastro:** o que é escrito agindo como outra pessoa fica no nome dela, com a marca de "entrar como" e quem agiu de verdade; a leitura do ticket não mostra essa marca.
- **Tela:** seção "Pessoas" nas Configurações, faixa fixa enquanto dura, selo "teste" onde pessoas são listadas ou escolhidas. O modo fica fixado no cliente da aba, e a tela confere com o servidor quem ela está sendo. Preferências ficam só de leitura no modo, para não gravar na conta do administrador.
- **Limites:** vinte pessoas de teste ativas e cem no total por organização; nome sem caracteres invisíveis e diferente do de qualquer pessoa ativa.
- **Assistente:** agindo como pessoa de teste, ele consulta só o que ela enxerga.

### Aceito sem mudança

- Com a ligação com o GitHub desligada, quatro rotas respondem "não encontrado" antes da conferência do cabeçalho; nada é atendido.
- Um administrador desativado volta a ficar ativo no próximo acesso com a sessão dele; quem decide é a sessão do Clerk.
- A proteção da marca depende de a API conectar ao banco com o papel da aplicação, e não com o dono das tabelas.
