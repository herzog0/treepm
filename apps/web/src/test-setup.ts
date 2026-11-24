import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import i18n from "./i18n/index.js";
import { loadDescriptionEditor } from "./ticket/description/RichDescription.js";

// O prazo padrão de `waitFor`/`findBy*` (1 s) estoura com a máquina carregada (a suíte inteira roda em paralelo, e cada render de conversa ou de mapa
// custa segundos): aguardar um efeito assíncrono não pode depender de a máquina estar livre. O prazo só pesa quando o teste vai falhar.
configure({ asyncUtilTimeout: 5000 });

// O editor da descrição é baixado sob demanda; os testes não medem essa espera (quem mede é RichDescription.lazy.test.tsx).
// Com o módulo já carregado, o componente renderiza o editor de imediato, como renderizava antes do carregamento sob demanda.
beforeAll(async () => {
  await loadDescriptionEditor();
}, 60_000);

// jsdom não faz layout: o mapa precisa de um palco com tamanho para montar a cena.
class FakeResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{ target, contentRect: { width: 1000, height: 700 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

// Os testes existentes conferem o texto em português: a interface começa sempre em pt-BR.
// Para outro idioma, `setTestLanguage` em `test/i18n.ts`.
beforeEach(async () => {
  await i18n.changeLanguage("pt-BR");
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 700, width: 1000, height: 700, toJSON: () => ({}),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
