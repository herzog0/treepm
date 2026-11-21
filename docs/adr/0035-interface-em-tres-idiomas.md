# ADR 0035 — Interface em três idiomas: português, inglês e espanhol do México

**Status:** Aceita por Teodoro em 2026-11-21 quanto ao objetivo; os pontos marcados como escolha da coordenação valem até ele dizer o contrário. O idioma do texto escrito pela IA está em aberto. A web inteira foi convertida em 2026-11-21 (PRs #81 a #88: `i18next` 27 com `react-i18next` 18, um catálogo por área, regra de lint contra texto literal em toda a web e teste de tela inteira por idioma). As traduções de inglês e de espanhol foram escritas pela IA e ainda não foram revisadas por quem fala o idioma; nada foi conferido com sessão real. **Data:** 2026-11-21.

## Contexto

Todo o texto da interface está escrito em português dentro dos componentes. Em 2026-11-21 Teodoro pediu:

> vc deve preparar tudo pra ser traduzido pra inglês, português e espanhol mexicano num primeiro momento.

O que existe hoje e pesa aqui:

- A web (`apps/web`) tem 35 componentes e 26 módulos com texto em português, um `plural.ts` que só conhece a regra do português, datas e números formatados com `"pt-BR"` fixo, `<html lang="pt-BR">` e os componentes do Clerk com a tradução `ptBR`.
- A web **não** mostra a mensagem que a API manda nos erros: ela traduz pelo código do erro. As mensagens da API são texto de diagnóstico.
- As preferências da pessoa já têm lugar e formato ([ADR 0028](0028-preferencias-por-usuario-e-pagina-de-configuracoes.md)).
- Os 899 testes da web conferem os textos em português.

## Decisão

### Idiomas

`pt-BR`, `en` e `es-MX`. O português é o idioma de origem: é nele que o texto é escrito primeiro e é ele que os testes existentes conferem.

### Como a pessoa escolhe *(escolha da coordenação)*

- Em Configurações, a preferência **Idioma**: "Automático", "Português (Brasil)", "English", "Español (México)". Fica nas preferências da pessoa (ADR 0028), então acompanha a conta em qualquer navegador.
- "Automático" é o padrão e segue o navegador: `pt*` vira `pt-BR`, `es*` vira `es-MX`, qualquer outro vira `en`.
- Antes de entrar (tela de acesso), vale o navegador.

### Na web

- **Nenhum texto visível fica escrito no componente.** Todo texto, inclusive `aria-label`, `title`, `placeholder`, mensagens de erro e textos montados com variáveis, vem de um catálogo por idioma.
- **Catálogo:** um arquivo por idioma e por parte da aplicação, em formato que uma pessoa tradutora consiga editar sem mexer em código.
- **Biblioteca** *(escolha da coordenação)*: `i18next` com `react-i18next`, desde que a documentação atual confirme os três requisitos abaixo; se não confirmar, a implementação propõe outra e diz por quê.
  1. chave que falta em um idioma faz uma verificação falhar (tipos ou teste), e não aparece só em produção;
  2. plural correto nos três idiomas, pela regra de cada um;
  3. textos com variáveis sem concatenação de pedaços.
- **Datas, números e maiúsculas** usam o idioma ativo.
- **Componentes do Clerk** usam a tradução do idioma ativo, com os mesmos ajustes de texto que o português tem hoje.
- **`<html lang>`** acompanha o idioma ativo.
- **Troca sem recarregar a página.**

### Traduções *(escolha da coordenação)*

- Os catálogos de inglês e de espanhol do México nascem completos, escritos pela IA que implementa. São uma primeira versão e precisam da revisão de quem fala o idioma.
- Termos fixos, para o produto falar igual em todo lugar:

| Português | English | Español (México) |
| --- | --- | --- |
| ticket | ticket | ticket |
| projeto | project | proyecto |
| time | team | equipo |
| área | area | área |
| mapa | map | mapa |
| Configurações | Settings | Configuración |
| A fazer | To do | Por hacer |
| Em andamento | In progress | En curso |
| Em revisão | In review | En revisión |
| Concluído | Done | Terminado |
| Cancelado | Canceled | Cancelado |
| ticket pai | parent ticket | ticket padre |
| item (de um ticket) | item | elemento |

### Na API

- A API continua sem idioma: a web traduz pelo código do erro e pelo tipo do evento. As mensagens de erro da API continuam em português, como texto de diagnóstico.
- Texto novo que a API mande para a pessoa ver passa a ser um código, traduzido na web.

### Testes

- Os testes existentes continuam rodando em português e servem de rede contra regressão: a troca de onde o texto vem não pode mudar nenhum texto em português.
- Um teste confere que os três catálogos têm exatamente as mesmas chaves e as mesmas variáveis em cada texto.
- Uma verificação impede texto literal novo em componente.
- Um teste por idioma renderiza as telas principais e confere que não sobra texto em português no inglês e no espanhol.

### Regra daqui para a frente

Todo texto visível da interface entra pelo catálogo, nos três idiomas, na mesma mudança. A regra vai para `CLAUDE.md` e `AGENTS.md`.

## Fora deste recorte

- Tradução do que as pessoas escrevem (títulos, descrições, comentários).
- Mensagens de erro da API em outros idiomas.
- A página de demonstração da engine, se não fizer parte do produto.
- Idiomas escritos da direita para a esquerda.
- ADRs, documentação e comentários de código, que continuam em português.

## Em aberto, para Teodoro: o idioma do que a IA escreve

A IA escreve o rascunho do ticket, as respostas da conversa, o texto "O que entra aqui" e o nome do ticket pai proposto. Hoje tudo sai em português, e os prompts e as perguntas ao Jev estão em português.

O texto de um ticket é compartilhado: pessoas com idiomas de interface diferentes leem o mesmo ticket. Por isso o idioma do conteúdo não deveria seguir o idioma da interface de quem está olhando.

- **Opção recomendada:** cada projeto tem um idioma de conteúdo, escolhido ao criar o projeto (o padrão é o idioma de quem cria), e a IA escreve nele.
- **Alternativa:** a IA responde no idioma em que a pessoa escreveu a mensagem.

Qualquer das duas mexe nos prompts, e a procura do caminho só foi medida em português. Nada disso entra neste recorte; os prompts não mudam aqui.
