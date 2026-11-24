const COPIED = ["boxSizing", "width", "overflowX", "overflowY", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize", "fontFamily", "lineHeight", "letterSpacing", "textTransform", "textIndent", "tabSize"] as const;

export interface CaretPoint {
  /** Coordenadas da tela do começo da linha do cursor (`bottom` é o pé da linha). */
  left: number;
  top: number;
  bottom: number;
}

/**
 * Onde o cursor está na tela, num campo de várias linhas: um espelho invisível com o mesmo texto e a mesma tipografia até o cursor
 * diz onde a linha quebra. Sem layout (jsdom) devolve o canto do campo.
 */
export function caretPoint(field: HTMLTextAreaElement, index: number): CaretPoint {
  const box = field.getBoundingClientRect();
  const style = window.getComputedStyle(field);
  const mirror = document.createElement("div");
  mirror.setAttribute("aria-hidden", "true");
  const target = mirror.style;
  target.position = "absolute";
  target.visibility = "hidden";
  target.top = "0";
  target.left = "-9999px";
  target.whiteSpace = "pre-wrap";
  target.overflowWrap = "break-word";
  for (const name of COPIED) target[name] = style[name];
  mirror.textContent = field.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = field.value.slice(index) || ".";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4 || 18;
  const x = marker.offsetLeft;
  const y = marker.offsetTop;
  document.body.removeChild(mirror);
  // `offsetLeft` e `offsetTop` partem da borda de dentro do espelho.
  const left = box.left + (Number.parseFloat(style.borderLeftWidth) || 0) + x - field.scrollLeft;
  const top = box.top + (Number.parseFloat(style.borderTopWidth) || 0) + y - field.scrollTop;
  return { left, top, bottom: top + lineHeight };
}
