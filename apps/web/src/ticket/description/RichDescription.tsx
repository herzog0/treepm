import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/core";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import type { JSONContent, Range } from "@tiptap/core";
import { useTranslation } from "react-i18next";
import { useStatusText } from "../../map/nodeContent.js";
import { descriptionDecorations, decorationsKey } from "./decorations.js";
import type { MentionContext } from "./decorations.js";
import { blockItems, mentionItems } from "./items.js";
import { descriptionExtensions, normalizeDescription, readMarkdown, valueAfterEdit } from "./markdown.js";
import { optionId, SuggestionMenu } from "./SuggestionMenu.js";
import type { MenuState } from "./SuggestionMenu.js";
import { suggestionExtension } from "./suggestions.js";
import type { MenuKind, SuggestionHost } from "./suggestions.js";
import { WriterRequest } from "./WriterRequest.js";
import type { DraftRequest } from "./WriterRequest.js";
import "./description.css";

export interface RichDescriptionProps {
  /** O texto guardado, em markdown. */
  value: string;
  /** Em edição: o texto aceita digitação. Fora dela é só leitura (e, com `canEdit`, as tarefas se marcam). */
  editing: boolean;
  /** Quem pode editar o ticket: o clique no texto pede a edição e as tarefas se marcam na leitura. */
  canEdit: boolean;
  /** Nome acessível do campo. */
  label: string;
  /** Convite quando o texto está vazio. */
  placeholder: string;
  /** Tickets do projeto para as menções e a lista do "@". Sem isso, chave é só texto. */
  mentions?: MentionContext;
  /** O texto mudou por edição. Sem edição, nunca é chamada: a leitura não regrava o texto. */
  onChange?: (text: string) => void;
  /** A pessoa clicou no texto (ou deu Enter nele) em leitura. */
  onRequestEdit?: () => void;
  /** O foco saiu do campo. */
  onLeave?: () => void;
  /** Ctrl+Enter. */
  onSubmit?: () => void;
  /** Esc, sem menu aberto. */
  onCancel?: () => void;
  /** Tarefa marcada ou desmarcada na leitura: o texto novo, já escrito. */
  onToggleTask?: (text: string) => void;
  /** Clique ou Enter em uma menção. */
  onOpenMention?: (ticketId: string) => void;
  /**
   * Pedir ao assistente um trecho para a descrição (ADR 0036, fatia 5). Com isto e a edição aberta, o menu "/" ganha
   * "Pedir ao assistente para escrever". Sem isto (assistente desligado, criação), o item não existe.
   */
  onDraft?: DraftRequest;
  /** O foco entra no texto quando a edição abre junto com o componente (o convite de uma descrição vazia). */
  autoFocus?: boolean;
  /** Classe extra no recipiente (por exemplo o contorno de campo, na criação). */
  className?: string;
}

const isInteractive = (target: EventTarget | null) => target instanceof Element && target.closest("a, input, label, button") !== null;

/** Descrição do ticket (ADR 0036): lê e edita o mesmo markdown pelo mesmo componente, com menu de blocos e menções. */
export function RichDescription(props: RichDescriptionProps) {
  const { value, editing, canEdit, label } = props;
  const { t } = useTranslation("ticket");
  const statusText = useStatusText();
  const id = useId();
  const wrapper = useRef<HTMLDivElement>(null);
  const latest = useRef({ ...props, t, statusText });
  useLayoutEffect(() => {
    latest.current = { ...props, t, statusText };
  });

  // O que o editor mostra e o que ele escreveria de volta sem edição: a base para a leitura nunca regravar o texto.
  const shown = useRef(value);
  const original = useRef(value);
  const baseline = useRef<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const menuRef = useRef<MenuState | null>(null);
  const pendingPos = useRef<number | "end">("end");
  const refocus = useRef(false);
  // O pedido ao assistente: aberto ou não, e a posição do cursor onde a proposta entra (acompanha as mudanças do texto).
  const [writing, setWriting] = useState(false);
  const writerPos = useRef(0);

  const setMenuState = useCallback((next: MenuState | null) => {
    menuRef.current = next;
    setMenu(next);
  }, []);

  const host = useMemo<SuggestionHost>(
    () => ({
      show(kind, suggestion) {
        const previous = menuRef.current;
        const selected = previous && previous.kind === kind && previous.query === suggestion.query ? Math.min(previous.selected, Math.max(suggestion.items.length - 1, 0)) : 0;
        setMenuState({ kind, query: suggestion.query, items: suggestion.items, selected, rect: suggestion.clientRect?.() ?? null, command: suggestion.command });
      },
      key(_kind, event) {
        const current = menuRef.current;
        if (!current) return false;
        const count = current.items.length;
        if (event.key === "Escape") {
          // Fecha só o menu: a página e a edição não veem esta tecla.
          event.stopPropagation();
          return true;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          if (count === 0) return false;
          setMenuState({ ...current, selected: (current.selected + (event.key === "ArrowDown" ? 1 : count - 1)) % count });
          return true;
        }
        if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          const item = current.items[current.selected];
          if (!item) return false;
          current.command(item);
          return true;
        }
        return false;
      },
      hide(kind: MenuKind) {
        if (menuRef.current?.kind === kind) setMenuState(null);
      },
    }),
    [setMenuState],
  );

  const askAssistant = useCallback(
    (current: Editor, range: Range) => {
      current.chain().focus().deleteRange(range).run();
      writerPos.current = range.from;
      setMenuState(null);
      setWriting(true);
    },
    [setMenuState],
  );

  const extensions = useMemo(
    () => [
      ...descriptionExtensions({ canToggleTasks: () => latest.current.canEdit, taskLabel: (text) => latest.current.t("description.task", { text }) }),
      descriptionDecorations(() => ({
        context: latest.current.mentions ? { ...latest.current.mentions, onOpen: latest.current.onOpenMention ?? latest.current.mentions.onOpen } : null,
        placeholder: latest.current.placeholder,
        statusText: latest.current.statusText,
      })),
      suggestionExtension("blocks", host, (query) => blockItems(latest.current.t, query, latest.current.onDraft ? askAssistant : undefined)),
      suggestionExtension("mention", host, (query) => (latest.current.mentions ? mentionItems(query, latest.current.mentions) : [])),
    ],
    [host, askAssistant],
  );

  const editor = useEditor({
    extensions,
    content: value,
    contentType: "markdown",
    editable: editing,
    editorProps: {
      handleKeyDown: (_view, event) => {
        if (event.key === "Escape" && menuRef.current === null && latest.current.onCancel) {
          // Esc sem menu desfaz o que não foi salvo; a página não vê a tecla.
          event.stopPropagation();
          refocus.current = true;
          latest.current.onCancel();
          return true;
        }
        if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && latest.current.onSubmit) {
          event.stopPropagation();
          refocus.current = true;
          latest.current.onSubmit();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: current }) => {
      const next = valueAfterEdit(readMarkdown(current), baseline.current ?? original.current, original.current);
      shown.current = next;
      latest.current.onChange?.(next);
    },
  });

  // A posição do pedido segue o texto: se a pessoa escreve antes dela enquanto espera, a proposta entra no lugar certo.
  useEffect(() => {
    if (!editor) return;
    const follow = ({ transaction }: { transaction: { docChanged: boolean; mapping: { map: (pos: number) => number } } }) => {
      if (transaction.docChanged) writerPos.current = transaction.mapping.map(writerPos.current);
    };
    editor.on("transaction", follow);
    return () => void editor.off("transaction", follow);
  }, [editor]);

  const closeWriter = useCallback(() => {
    // O foco volta ao texto antes de o campo sair: perder o foco de dentro do componente não pode contar como sair da edição.
    editor?.commands.focus();
    setWriting(false);
  }, [editor]);
  const insertProposal = useCallback(
    (text: string) => {
      if (!editor) return;
      const parsed = (editor as unknown as { markdown: { parse: (markdown: string) => JSONContent } }).markdown.parse(text);
      const position = Math.min(writerPos.current, editor.state.doc.content.size);
      editor.chain().focus().insertContentAt(position, parsed.content ?? []).run();
      setWriting(false);
    },
    [editor],
  );

  if (baseline.current === null) baseline.current = normalizeDescription(value);

  // O texto guardado mudou por fora (outro ticket, recarga, descarte): o editor passa a mostrá-lo.
  useEffect(() => {
    if (!editor) return;
    if (value !== shown.current) {
      shown.current = value;
      original.current = value;
      editor.commands.setContent(value, { emitUpdate: false, contentType: "markdown" });
      baseline.current = readMarkdown(editor);
    } else if (original.current !== value) {
      // O que foi escrito pela edição foi guardado: agora é o texto de origem, e o editor já o mostra.
      original.current = value;
      baseline.current = readMarkdown(editor);
    }
  }, [value, editor, editing]);

  const redecorate = useCallback((current: Editor) => current.view.dispatch(current.state.tr.setMeta(decorationsKey, true)), []);

  // Abre e fecha a edição.
  const wasEditing = useRef(editing && !props.autoFocus);
  useEffect(() => {
    if (!editor) return;
    editor.setEditable(editing, false);
    redecorate(editor);
    if (editing && !wasEditing.current) editor.commands.focus(pendingPos.current);
    if (!editing) {
      setMenuState(null);
      setWriting(false);
      if (wasEditing.current && refocus.current) wrapper.current?.focus();
    }
    refocus.current = false;
    wasEditing.current = editing;
  }, [editing, editor, redecorate, setMenuState]);

  // Tickets, títulos e situações mudaram: as menções se refazem.
  useEffect(() => {
    if (editor) redecorate(editor);
  }, [editor, redecorate, props.mentions, props.placeholder, props.onOpenMention]);

  // Nome do campo e menu aberto, para quem usa leitor de tela.
  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    if (editing) {
      dom.setAttribute("role", "textbox");
      dom.setAttribute("aria-multiline", "true");
      dom.setAttribute("aria-label", label);
      dom.setAttribute("aria-haspopup", "listbox");
    } else {
      for (const name of ["role", "aria-multiline", "aria-label", "aria-haspopup"]) dom.removeAttribute(name);
    }
    // A cada renderização: o ProseMirror reescreve os atributos do campo quando as opções do editor se atualizam.
  });
  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom || !editing) return;
    if (menu && menu.items.length > 0) {
      dom.setAttribute("aria-controls", `${id}-menu`);
      dom.setAttribute("aria-expanded", "true");
      dom.setAttribute("aria-activedescendant", optionId(id, menu.selected));
    } else {
      for (const name of ["aria-controls", "aria-expanded", "aria-activedescendant"]) dom.removeAttribute(name);
    }
  });

  // Marcar e desmarcar tarefa na leitura: o Tiptap só avisa; quem escreve no documento é este trecho.
  useEffect(() => {
    const element = wrapper.current;
    if (!element || !editor) return;
    const onChange = (event: Event) => {
      const input = event.target;
      if (editor.isEditable || !(input instanceof HTMLInputElement) || input.type !== "checkbox" || !latest.current.canEdit) return;
      const items = Array.from(element.querySelectorAll('ul[data-type="taskList"] > li'));
      const index = items.indexOf(input.closest('ul[data-type="taskList"] > li') as Element);
      if (index < 0) return;
      let seen = -1;
      let position = -1;
      editor.state.doc.descendants((node, pos) => {
        if (node.type.name === "taskItem" && ++seen === index) position = pos;
        return position < 0;
      });
      const node = editor.state.doc.nodeAt(position);
      if (!node) return;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(position, undefined, { ...node.attrs, checked: input.checked }));
      const next = valueAfterEdit(readMarkdown(editor), baseline.current ?? original.current, original.current);
      shown.current = next;
      latest.current.onToggleTask?.(next);
    };
    element.addEventListener("change", onChange);
    return () => element.removeEventListener("change", onChange);
  }, [editor]);

  const onClick = (event: MouseEvent) => {
    const mention = (event.target as Element).closest<HTMLElement>("[data-ticket-id]");
    if (mention?.dataset.ticketId && latest.current.onOpenMention) {
      event.preventDefault();
      latest.current.onOpenMention(mention.dataset.ticketId);
      return;
    }
    if (editing || !canEdit || !props.onRequestEdit || isInteractive(event.target) || !editor) return;
    pendingPos.current = editor.view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? "end";
    props.onRequestEdit();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.ctrlKey || event.metaKey) return;
    const mention = (event.target as Element).closest<HTMLElement>("[data-ticket-id]");
    if (!editing && mention?.dataset.ticketId && latest.current.onOpenMention) {
      event.preventDefault();
      latest.current.onOpenMention(mention.dataset.ticketId);
    } else if (!editing && canEdit && event.target === event.currentTarget && props.onRequestEdit) {
      event.preventDefault();
      pendingPos.current = "end";
      props.onRequestEdit();
    }
  };

  const onBlur = (event: React.FocusEvent) => {
    if (!editing || !props.onLeave) return;
    const next = event.relatedTarget as Node | null;
    if (next && event.currentTarget.contains(next)) return;
    props.onLeave();
  };

  const readable = !editing && canEdit && props.onRequestEdit !== undefined;
  const classes = ["description", editing ? "is-editing" : "is-reading", readable ? "is-clickable" : "", props.className ?? ""].filter(Boolean).join(" ");
  return (
    <div
      ref={wrapper}
      className={classes}
      tabIndex={readable ? 0 : undefined}
      {...(readable ? { role: "group", "aria-label": label } : {})}
      onClick={onClick}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    >
      <EditorContent editor={editor} />
      {menu && editing && <SuggestionMenu state={menu} idPrefix={id} />}
      {writing && editing && props.onDraft && editor && (
        <WriterRequest
          anchor={() => {
            const at = editor.view.coordsAtPos(Math.min(writerPos.current, editor.state.doc.content.size));
            return { left: at.left, top: at.top, bottom: at.bottom };
          }}
          currentText={() => shown.current}
          onDraft={props.onDraft}
          onInsert={insertProposal}
          onClose={closeWriter}
        />
      )}
    </div>
  );
}
