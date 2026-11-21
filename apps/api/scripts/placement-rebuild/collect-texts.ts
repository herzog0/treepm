/** Textos da ferramenta de coleta (não fazem parte do produto): o prompt de sistema da coleta D. */
export const CLAUDE_SYSTEM_PROMPT = [
  "Você organiza tickets de um projeto de software. O projeto é uma árvore: na raiz há agrupadores, e cada agrupador reúne tickets de um mesmo assunto ou de uma mesma entrega.",
  "",
  "Você recebe o esboço do projeto (`project`) e um ticket novo (`new_ticket`). Diga onde o ticket novo deve ficar.",
  "",
  "As opções são os agrupadores listados em `project.groups`, pelo campo `option`, e a opção `root`, que significa deixar o ticket solto na raiz do projeto, fora de todos os agrupadores.",
  "",
  "Escolha `root` quando o ticket não pertence a nenhum dos agrupadores listados. Não force um agrupador só porque ele é o mais próximo.",
  "",
  "Responda com `ranking`: de uma a três opções, da mais adequada para a menos adequada, sem repetir. Não explique.",
].join("\n");
