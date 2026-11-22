# Interface em três idiomas (ADR 0035)

`pt-BR` (idioma de origem), `en` e `es-MX`. Nenhum texto visível fica escrito em componente: tudo vem de um catálogo.
Biblioteca: `i18next` + `react-i18next`. Os três catálogos são embutidos no pacote (sem carregamento assíncrono).

## Estrutura

```
i18n/
  locales/<idioma>/<área>.json   um arquivo por idioma e por área (diretório de src)
  resources.ts                   registra os arquivos; dele saem os tipos das chaves
  index.ts                       a instância do i18next e o <html lang>
  languages.ts                   idiomas, preferência "auto" e a escolha pelo navegador
  format.ts                      datas, números e maiúsculas no idioma ativo
  clerk.ts                       tradução dos componentes do Clerk por idioma
  LanguageSync.tsx               aplica a preferência da pessoa (dentro do provedor de preferências)
  parity.ts / parity.test.ts     paridade dos catálogos
```

Área = diretório de `src`; `app` é a raiz (`App.tsx`, `Workspace.tsx`…). Toda área tem os seus três arquivos, registrados em
`resources.ts`. Área nova: crie os três arquivos e registre-os lá.

## Texto novo ou alterado

1. Leia a ADR 0035 (tabela de termos fixos: vale letra por letra).
2. Escreva o teste primeiro (TDD) e rode: ele falha.
3. Coloque o texto em `locales/pt-BR/<área>.json` e a tradução em `en` e `es-MX` na mesma mudança.
4. No componente:

```tsx
const { t } = useTranslation("settings");   // o namespace é a área
<h1>{t("title")}</h1>
<button aria-label={t("camera.close")}>
```

5. A regra de lint vale para todo `.tsx` de `apps/web/src` fora de testes: `pnpm exec eslint apps/web` acusa texto literal
   dentro de JSX e em `aria-label`, `title`, `placeholder` e `alt`. Não há diretório isento.

A regra só enxerga JSX e atributos. Texto em função, objeto de rótulos ou `throw new Error` que chegue à tela também entra
pelo catálogo (receba o `t`, veja abaixo). O que a IA escreve (rascunho, respostas, título de ticket pai proposto) e o que vem
da API (títulos, nomes) não é texto de interface e aparece como veio.

Fora de componente (funções puras, hooks), receba o `t` por parâmetro (`import type { TFunction } from "i18next"`) ou use
`useTranslation` num hook. Evite `i18n.t` solto: ele não re-renderiza quando o idioma muda.

## Nomes de chave

Pelo sentido, em inglês, aninhados por tela e elemento: `settings.language.label`, `teams.detail.remove.confirm`.
Nunca pelo texto. A chave é tipada a partir do catálogo `pt-BR`: chave inexistente não compila.
Chave dinâmica só com união de literais (`` t(`language.${option}`) ``), e todas as chaves da união têm de existir.

## Variáveis

Sempre interpolação do catálogo, nunca concatenação: `"removeMemberLabel": "Remover {{name}}"` e
`t("detail.removeMemberLabel", { name })`. A ordem das palavras muda de idioma para idioma, então a variável fica dentro
da frase. Os três idiomas usam as **mesmas** variáveis em cada texto (o teste de paridade confere).

## Plural

Nunca `count === 1 ? … : …`. Passe `count` e escreva uma forma por categoria da regra do idioma:

```json
// pt-BR                              // en                          // es-MX
"members_zero":  "{{count}} membros", "members_one":   "{{count}} member",  "members_one":   "{{count}} miembro",
"members_one":   "{{count}} membro",  "members_other": "{{count}} members", "members_many":  "{{count}} miembros",
"members_many":  "{{count}} membros",                                       "members_other": "{{count}} miembros"
"members_other": "{{count}} membros"
```

`t("list.members", { count })`. Todas as formas usam `{{count}}`. As categorias exigidas são as do `Intl.PluralRules`
do idioma: `en` = `one`/`other`; `pt-BR` e `es-MX` = `one`/`many`/`other` (`many` cobre milhões). O português manda o 0
para o singular, então onde o texto de hoje diz "0 membros" use também `_zero` (permitido em qualquer idioma). O teste de paridade
acusa forma que falta ou que o idioma não usa.

## Marcação no meio da frase (negrito, link, código)

Use `Trans` com marcação no catálogo, sem quebrar a frase em pedaços:

```json
"hint": "Defina <code>VITE_CLERK_PUBLISHABLE_KEY</code> em <code>apps/web/.env.local</code>."
```
```tsx
<Trans i18nKey="config.hint" components={{ code: <code /> }} />   // com useTranslation("app") no mesmo componente, ou ns="app"
```

As etiquetas (`<code>`, `<0>`) também têm de ser as mesmas nos três idiomas.

## Datas, números e maiúsculas

De `i18n/format.ts`, sempre com o idioma ativo; nunca `"pt-BR"` fixo, nem `toLocaleString("pt-BR")`:

```tsx
const { i18n } = useTranslation();
const language = i18n.language as Language;   // "pt-BR" | "en" | "es-MX"
formatDate(language, iso);        // 20 de novembro de 2026 · November 20, 2026 · 20 de noviembre de 2026
formatNumber(language, 1234.5);   // 1.234,5 · 1,234.5 · 1,234.5
toUpper(language, texto);
```

Tempo relativo ("há 2 minutos"): `relativeTimeText` em `github/relativeTime.ts`, com chaves de plural do catálogo.

## Testes

- `test-setup.ts` fixa `pt-BR` antes de cada teste: os testes existentes não mudam.
- Para outro idioma, `await setTestLanguage("en")` (`test/i18n.ts`) antes do `render`.
- `parity.test.ts` percorre **todos** os `locales/*/*.json`: mesmos arquivos, mesmas chaves, mesmas variáveis e as formas de
  plural de cada idioma. Também confere que todo arquivo está registrado em `resources.ts`.
- Um teste por idioma que renderiza a sua área e confere os textos esperados e a ausência de português: veja
  `screens.test.tsx` (função `expectNoPortuguese`).
- A verificação de texto literal tem teste próprio (`noLiteralText.test.ts`).
- `fullScreens.test.tsx` renderiza as telas principais em `en` e `es-MX` com o cliente falso e falha se sobrar palavra que só
  existe no português dos catálogos. Os dados falsos desse teste usam palavras neutras (nomes próprios e termos iguais nos três
  idiomas): português nos dados falsos seria confundido com texto de interface.

## Idioma ativo

Preferência `language` (`"auto" | "pt-BR" | "en" | "es-MX"`, ADR 0028), em Configurações. `LanguageSync` aplica: `"auto"`
segue `navigator.languages` (`pt*` → `pt-BR`, `es*` → `es-MX`, outro → `en`). Antes de entrar, vale o navegador.
`<html lang>` e a tradução do Clerk acompanham, sem recarregar.

## Traduções

Primeira versão escrita pela IA; precisa de revisão de quem fala o idioma. Espanhol com "tú", neutro para o México.

## Mensagens de erro da API

Em componente: `const describeError = useDescribeApiError();` (de `api/errorText.ts`) e `describeError(error, action?)`; acompanha a troca de idioma.
Fora de componente: `describeApiError(t, error, action?)`. O catálogo é `api` (`errors.code.*`, `errors.kind.*`); código desconhecido cai no tipo.
