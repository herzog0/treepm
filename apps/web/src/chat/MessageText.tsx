import { useTranslation } from "react-i18next";
import { RichDescription } from "../ticket/description/RichDescription.js";

const URL_PATTERN = /https?:\/\/[^\s<>"]+/g;
const TRAILING = /[.,;:!?)\]'"]+$/;

/** Só endereços `http(s)` completos viram link; nada é buscado nem carregado, e o que não é endereço fica como texto. */
function safeHref(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? candidate : null;
  } catch {
    return null;
  }
}

/** Mensagem de pessoa (ADR 0049): texto puro com as quebras de linha; endereços http(s) reconhecidos viram link que só abre por clique, em aba nova. */
export function PersonText({ text }: { text: string }) {
  const parts: (string | { href: string; label: string })[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const raw = match[0];
    const label = raw.replace(TRAILING, "");
    const href = safeHref(label);
    if (href === null || label === "") continue;
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ href, label });
    last = match.index + label.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return (
    <span className="chat-text">
      {parts.map((part, index) =>
        typeof part === "string" ? (
          part
        ) : (
          <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">
            {part.label}
          </a>
        ),
      )}
    </span>
  );
}

/**
 * A resposta do assistente: o leitor de markdown restrito da descrição do ticket (ADR 0036), que nunca cria imagem, HTML nem carrega nada
 * remoto; links só abrem por clique, em aba nova, com `rel="noopener noreferrer nofollow"`.
 */
export function AssistantText({ text }: { text: string }) {
  const { t } = useTranslation("chat");
  return <RichDescription className="is-answer" value={text} editing={false} canEdit={false} label={t("assistant.reply")} placeholder="" />;
}

/** Iniciais no lugar da foto: `avatarUrl` é endereço remoto e o chat não carrega nada de fora. */
export function Initials({ name }: { name: string }) {
  const letters = name.trim().split(/\s+/).slice(0, 2).map((word) => word.charAt(0).toLocaleUpperCase()).join("");
  return <span className="chat-initials" aria-hidden="true">{letters}</span>;
}
