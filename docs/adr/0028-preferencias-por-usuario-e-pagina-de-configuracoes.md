# ADR 0028 — Preferências por usuário, página de configurações e câmera ao fechar o ticket

**Status:** Aceita. **Data:** 2026-11-20.

## Contexto

A [ADR 0026](0026-pagina-do-ticket-e-zoom-ate-a-folha.md) deixou provisório o que a câmera faz ao fechar a página do ticket. Teodoro decidiu em 2026-11-20: "volta ao lugar de antes, mas coloca isso como uma configuração numa página de configurações, seção câmera. Quero que o usuário tenha controle sobre todo esse tipo de coisa, a nível de usuário não de plataforma."

A plataforma ainda não tem preferências nem página de configurações.

## Decisão

### Princípio

Comportamento de interface que é questão de gosto vira preferência da pessoa, com um padrão sensato, e não regra fixa da plataforma. Cada preferência nova entra na página de configurações, na seção a que pertence.

### Onde as preferências ficam

No `unsafeMetadata` do usuário no Clerk, sob a chave `treepm.preferences`, gravado pela web com `user.updateMetadata`, que mescla as chaves em vez de substituir o objeto.

- **Por que ali:** a preferência é da pessoa, e a mesma pessoa pode estar em mais de uma organização. Uma tabela por usuário, sem `org_id`, contrariaria as ADRs [0019](0019-clerk-organizacao-como-tenant.md) e [0021](0021-neon-postgres-e-rls-por-organizacao.md) e pediria migration; uma por pessoa da organização faria a preferência mudar ao trocar de organização. O metadado do Clerk acompanha a pessoa entre organizações e aparelhos, sem banco nem API.
- **Limites aceitos:** o Clerk limita os metadados a 8 KB; preferências são poucos valores curtos. O valor é gravável pelo próprio navegador, então **nunca é usado para autorização** nem lido pela API.
- **Formato:** `{ "treepm": { "preferences": { "v": 1, "camera": { "onTicketClose": "restore" } } } }`. A leitura valida com Zod; valor ausente ou inválido vira o padrão, campo a campo.
- A web lê e grava por um único ponto (um contexto com um gancho), com implementação falsa nos testes. O mapa nunca espera a leitura: sem dado, vale o padrão. Falha ao gravar mostra a mensagem na página de configurações e mantém o valor anterior.

Se um dia a API precisar de uma preferência, ela passa a ter armazenamento próprio em outra ADR.

### Página de configurações

`?view=settings`, no padrão de navegação da [ADR 0023](0023-telas-de-administracao-e-mapa-da-organizacao.md), com o link "Configurações" no cabeçalho, depois de "Times". A página tem seções; a primeira e única agora é **Câmera**.

- Cada preferência aplica na hora, sem botão de salvar.
- Só entram as preferências decididas. Nesta ADR, uma.

### Câmera ao fechar o ticket

Preferência "Ao fechar um ticket", na seção Câmera:

- **Voltar ao lugar de antes** (padrão).
- **Ficar onde está.**

"Lugar de antes" é o centro e a escala da câmera, em coordenadas do mapa, no momento em que a página passa de fechada a aberta.

- Trocar de ticket com a página aberta não regrava esse lugar.
- Vale para qualquer forma de fechar: botão, Esc, voltar do navegador e remoção do ticket.
- Página aberta direto pelo endereço não tem lugar anterior; ao fechar, a câmera fica onde está.
- A volta usa a animação da câmera do pacote e respeita a preferência de movimento reduzido. `packages/engine` e `packages/react` não mudam.

Isso substitui o trecho provisório da ADR 0026 e resolve a dúvida 12 do blueprint.

## Consequências

- A pessoa escolhe o comportamento, e a escolha a acompanha em qualquer organização e aparelho em que entrar.
- As preferências dependem do Clerk estar acessível para gravar; a leitura vem junto com o usuário já carregado.
- A API não conhece as preferências. Um comportamento do servidor que dependa de preferência vai exigir outra decisão.
- A página de configurações nasce com uma opção só; cresce conforme as decisões.

## Alteração de 2026-11-22: a câmera fica onde está

Teodoro pediu em 2026-11-22: "remova a feature de voltar pro lugar original onde se iniciou um clique ao fechar a aba do ticket aberto no momento. faz a camera continuar exatamente onde esta". Fechar um ticket deixa de mover a câmera, e a preferência "Ao fechar um ticket" sai de Configurações junto com a seção "Câmera", que só tinha essa opção. O foco da câmera ao abrir um ticket continua. O mecanismo de preferências por pessoa desta ADR permanece. Em implementação no `TREEPM-181`.
