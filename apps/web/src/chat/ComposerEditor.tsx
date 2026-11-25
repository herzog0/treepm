import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { forwardRef, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { personIdsIn } from "@treepm/domain";
import type { Person, TicketSummary } from "../api/client.js";
import { fold, MAX_RESULTS, searchTickets } from "../command/search.js";
import { useStatusText } from "../map/nodeContent.js";
import { MentionPicker, pickerOptionId } from "../mentions/MentionPicker.js";
import { mentionExtensions } from "../mentions/nodes.js";
import { useSuggestionHost } from "../mentions/useSuggestionHost.js";
import { descriptionDecorations, decorationsKey } from "../ticket/description/decorations.js";
import type { MentionContext } from "../ticket/description/decorations.js";
import { insertMention } from "../ticket/description/items.js";
import { closeSuggestion, suggestionExtension } from "../ticket/description/suggestions.js";
import type { MenuItem } from "../ticket/description/suggestions.js";
import "../ticket/description/description.css";
import type { TicketPool } from "./ChatsContext.js";
import { chatDocFromText, chatTextFromDoc, neutralizePaste } from "./chatText.js";

export interface ComposerHandle {
  focus: () => void;
  /** Tira do texto todos os itens daquela pessoa (o "Tirar" da linha de recusa). */
  removePerson: (personId: string) => void;
}

interface ComposerEditorProps {
  label: string;
  placeholder: string;
  /** O texto da mensagem, como será enviado; mudar por fora (limpar, devolver um envio que falhou) refaz o campo. */
  text: string;
  onText: (text: string) => void;
  /** Enter sem a lista aberta. */
  onEnter: () => void;
  readOnly: boolean;
  invalid: boolean;
  people: readonly { person: Person; blocked: boolean; reason?: "project" | "levels" }[];
  peopleStatus: "loading" | "ready" | "error";
  tickets: TicketPool;
  /** O caminho do ticket na árvore, para a linha de baixo da opção. */
  pathOf: (ticket: TicketSummary) => string;
  onNeedTickets: () => void;
  onRetryTickets: () => void;
  /** As pessoas de fora que a mensagem vai levar para uma thread nova: aparecem no texto na cor da thread (ADR 0059). */
  outsideIds: readonly string[];
}

const outsideKey = new PluginKey("composerOutside");

/**
 * O campo de escrever das conversas (ADR 0058): o mesmo editor da descrição e dos comentários, em configuração mínima (parágrafo,
 * quebra de linha, itens de menção e seletor). Enter envia, Shift+Enter quebra a linha, colar entra como texto puro.
 */
export const ComposerEditor = forwardRef<ComposerHandle, ComposerEditorProps>(function ComposerEditor(props, handle) {
  const { t } = useTranslation("chat");
  const statusText = useStatusText();
  const id = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const latest = useRef({ ...props, statusText });
  useLayoutEffect(() => {
    latest.current = { ...props, statusText };
  });
  const { menu, menuRef, setMenuState, host } = useSuggestionHost();
  const lastText = useRef(props.text);
  const pool = useMemo(() => (props.tickets.status === "ready" ? Object.values(props.tickets.byProject).flat() : []), [props.tickets]);
  const byKey = useMemo(() => new Map(pool.map((ticket) => [ticket.key, ticket] as const)), [pool]);
  const context = useMemo<MentionContext>(() => ({ projectId: "", anyProject: true, tickets: pool }), [pool]);

  // As opções das duas listas, sempre com o que há de mais novo (tickets e pessoas chegam depois de a lista abrir).
  const ticketOptions = useRef<(query: string) => MenuItem[]>(() => []);
  const personOptions = useRef<(query: string) => MenuItem[]>(() => []);
  ticketOptions.current = (query) => {
    latest.current.onNeedTickets();
    const found = query.trim() === "" ? latestPool.current.slice(0, MAX_RESULTS) : searchTickets(query, latest.current.tickets.status === "ready" ? latest.current.tickets.byProject : {});
    return found.map((ticket) => ({ id: ticket.id, label: `${ticket.key} ${ticket.title}`, ticket, run: (editor, range) => insertMention(editor, range, { type: "ticketMention", attrs: { key: ticket.key } }) }));
  };
  personOptions.current = (query) => {
    const wanted = fold(query).trim();
    const taken = new Set(personIdsIn(lastText.current));
    return latest.current.people
      .filter(({ person }) => !taken.has(person.id) && fold(person.displayName).includes(wanted))
      .map(({ person, blocked, reason }) => ({ id: person.id, label: person.displayName, person: { id: person.id, name: person.displayName, blocked, ...(reason ? { reason } : {}), isTest: person.isTest === true }, run: (editor, range) => insertMention(editor, range, { type: "personMention", attrs: { id: person.id, name: person.displayName } }) }));
  };

  const extensions = useMemo(
    () => [
      StarterKit.configure({ heading: false, bold: false, italic: false, strike: false, code: false, codeBlock: false, blockquote: false, bulletList: false, orderedList: false, listItem: false, horizontalRule: false, link: false, underline: false, trailingNode: false }),
      ...mentionExtensions({ exists: (key) => latest.current.tickets.status === "ready" && Object.values(latest.current.tickets.byProject).some((list) => list.some((ticket) => ticket.key === key)) }),
      descriptionDecorations(() => ({ context: { projectId: "", anyProject: true, tickets: latestPool.current }, people: null, placeholder: latest.current.placeholder, statusText: latest.current.statusText })),
      Extension.create({
        name: "composerOutside",
        addProseMirrorPlugins: () => [
          new Plugin({
            key: outsideKey,
            props: {
              decorations: (state) => {
                const outside = latest.current.outsideIds;
                if (outside.length === 0) return DecorationSet.empty;
                const found: Decoration[] = [];
                state.doc.descendants((node, pos) => void (node.type.name === "personMention" && outside.includes(node.attrs["id"] as string) && found.push(Decoration.node(pos, pos + node.nodeSize, { class: "is-outside" }))));
                return DecorationSet.create(state.doc, found);
              },
            },
          }),
        ],
      }),
      suggestionExtension("ticket", host, (query) => ticketOptions.current(query)),
      suggestionExtension("person", host, (query) => personOptions.current(query), () => !latest.current.readOnly),
    ],
    [host],
  );
  const latestPool = useRef(pool);
  useLayoutEffect(() => {
    latestPool.current = pool;
  });

  // Tickets ou pessoas chegaram com a lista já aberta: ela se refaz com o mesmo trecho digitado.
  useEffect(() => {
    const open = menuRef.current;
    if (open === null || open.kind === "blocks") return;
    const items = (open.kind === "ticket" ? ticketOptions : personOptions).current(open.query);
    setMenuState({ ...open, items, selected: Math.min(open.selected, Math.max(items.length - 1, 0)) });
  }, [pool, props.people]);

  const editor = useEditor({
    extensions,
    content: chatDocFromText(props.text, byKey),
    editable: !props.readOnly,
    editorProps: {
      handleKeyDown: (view, event) => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.ctrlKey || event.metaKey) return false;
        // Com a lista aberta, Enter nunca envia: confirma a opção (a lista trata a tecla); sem opção nenhuma, só fecha a lista.
        const open = menuRef.current;
        if (open !== null && open.kind !== "blocks") {
          if (open.items.length === 0) {
            closeSuggestion(view, open.kind);
            return true;
          }
          return host.key(open.kind, event) || true;
        }
        event.preventDefault();
        latest.current.onEnter();
        return true;
      },
      handlePaste: (_view, event) => {
        const raw = event.clipboardData?.getData("text/plain");
        if (raw === undefined || raw === "") return true;
        const text = neutralizePaste(raw.replace(/\r\n?/g, "\n"));
        const visible = new Map(latestPool.current.map((ticket) => [ticket.key, ticket] as const));
        const content = chatDocFromText(text, visible).content?.[0]?.content ?? [];
        editorRef.current?.chain().setMeta("paste", true).insertContent(content).run();
        return true;
      },
      handleDrop: () => true,
      handleDOMEvents: {
        // A lista não sobrevive ao foco que sai do campo (Tab ou clique fora); clicar numa opção não tira o foco (a lista segura o `mousedown`).
        blur: (view) => {
          const open = menuRef.current;
          if (open !== null && open.kind !== "blocks") closeSuggestion(view, open.kind);
          return false;
        },
      },
    },
    onUpdate: ({ editor: current }) => {
      const next = chatTextFromDoc(current.getJSON());
      lastText.current = next;
      latest.current.onText(next);
    },
  });
  const editorRef = useRef(editor);
  editorRef.current = editor;

  useImperativeHandle(
    handle,
    () => ({
      focus: () => void editorRef.current?.commands.focus("end"),
      removePerson: (personId) => {
        const current = editorRef.current;
        if (!current) return;
        const spans: [number, number][] = [];
        current.state.doc.descendants((node, pos) => void (node.type.name === "personMention" && node.attrs["id"] === personId && spans.push([pos, pos + node.nodeSize])));
        const tr = current.state.tr;
        for (const [from, to] of spans.reverse()) tr.delete(from, to);
        current.view.dispatch(tr);
        current.commands.focus();
      },
    }),
    [],
  );

  // O texto mudou por fora (a mensagem foi enviada, ou um envio que falhou voltou ao campo): o campo mostra o novo texto.
  useEffect(() => {
    if (!editor || props.text === lastText.current) return;
    lastText.current = props.text;
    editor.commands.setContent(chatDocFromText(props.text, byKey), { emitUpdate: false });
  }, [props.text, editor, byKey]);
  useEffect(() => void editor?.setEditable(!props.readOnly, false), [editor, props.readOnly]);
  // Tickets chegaram depois do rascunho: as chaves dele que agora existem viram itens, se a pessoa não mexeu no campo.
  useEffect(() => {
    if (!editor || chatTextFromDoc(editor.getJSON()) !== lastText.current) return;
    const next = chatDocFromText(lastText.current, byKey);
    if (JSON.stringify(next) !== JSON.stringify(editor.getJSON())) editor.commands.setContent(next, { emitUpdate: false });
  }, [byKey, editor]);
  useEffect(() => void (editor && editor.view.dispatch(editor.state.tr.setMeta(decorationsKey, true))), [editor, context, props.placeholder]);
  // Quem é "de fora" mudou (a pessoa saiu ou entrou na conversa): as decorações do texto se refazem.
  const outsideSignature = props.outsideIds.join(",");
  useEffect(() => void (editor && editor.view.dispatch(editor.state.tr.setMeta(outsideKey, outsideSignature))), [editor, outsideSignature]);

  // O papel do campo não muda no meio da digitação: é sempre uma caixa de combinação, aberta ou fechada. Em efeito de layout: o leitor de
  // tela e os testes leem estes atributos logo depois de a lista aparecer, sem esperar o efeito passivo.
  useLayoutEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    dom.setAttribute("role", "combobox");
    dom.setAttribute("aria-multiline", "true");
    dom.setAttribute("aria-label", props.label);
    dom.setAttribute("aria-haspopup", "listbox");
    dom.setAttribute("aria-autocomplete", "list");
    dom.setAttribute("aria-expanded", String(menu !== null && menu.kind !== "blocks"));
    if (props.invalid) dom.setAttribute("aria-invalid", "true");
    else dom.removeAttribute("aria-invalid");
    const open = menu !== null && menu.kind !== "blocks";
    if (open) {
      dom.setAttribute("aria-controls", `${id}-list`);
      const active = menu.items[menu.selected];
      if (active) dom.setAttribute("aria-activedescendant", pickerOptionId(id, active.id));
    } else {
      dom.removeAttribute("aria-controls");
      dom.removeAttribute("aria-activedescendant");
    }
  });

  const closeMessage = useCallback((): ReactNode => {
    if (menu === null || menu.kind === "blocks") return undefined;
    if (menu.kind === "person") {
      if (props.peopleStatus === "loading") return <p role="status" className="mention-note">{t("picker.loading")}</p>;
      if (props.peopleStatus === "error") return <p role="alert" className="mention-note">{t("picker.failed")}</p>;
      return undefined;
    }
    const status = props.tickets.status;
    if (status === "idle" || status === "loading") return <p role="status" className="mention-note">{t("picker.loadingTickets")}</p>;
    if (status === "error")
      return (
        <div className="mention-note">
          <p role="alert">{t("picker.failedTickets")}</p>
          <button type="button" onClick={props.onRetryTickets}>{t("picker.retry")}</button>
        </div>
      );
    return undefined;
  }, [menu, props.peopleStatus, props.tickets.status, props.onRetryTickets, t]);

  return (
    <div ref={wrapper} className="description is-editing chat-composer-editor">
      <EditorContent editor={editor} />
      {menu !== null && menu.kind !== "blocks" && (
        <MentionPicker
          state={{ kind: menu.kind, query: menu.query, items: menu.items, selected: menu.selected, command: menu.command, point: menu.rect ? { left: menu.rect.left, top: menu.rect.top, bottom: menu.rect.bottom } : null }}
          box={wrapper.current?.getBoundingClientRect() ?? null}
          idPrefix={id}
          message={closeMessage()}
          pathOf={props.pathOf}
        />
      )}
    </div>
  );
});
