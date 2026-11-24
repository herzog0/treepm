import { vi } from "vitest";
import { Sidebar } from "../nav/Sidebar.js";
import type { View } from "../nav/navigation.js";

// Textos do Clerk trocados por botões: não são da interface do TreePM.
export const CLERK_STUB = { org: "Organização de Teste Ltda", status: "Administrador", account: "Conta" };

/**
 * A barra lateral montada como o `AuthenticatedApp` a monta (ADR 0055), com o seletor da organização e o avatar do Clerk trocados por
 * botões de mesmo tamanho e mesmas classes `cl-*`. Usada pelas suítes de navegador do layout e dos chats.
 */
export function TestSidebar({ view = "map", onNavigate = () => undefined, onNewTicket = vi.fn(), onSearch = vi.fn() }: { view?: View; onNavigate?: (view: View) => void; onNewTicket?: () => void; onSearch?: () => void }) {
  return (
    <Sidebar
      view={view}
      onNavigate={onNavigate}
      onNewTicket={onNewTicket}
      onSearch={onSearch}
      organization={
        <button type="button" className="cl-organizationSwitcherTrigger" style={{ display: "flex", alignItems: "center", gap: 8, height: 36, padding: "0 10px", border: 0, borderRadius: 6, background: "transparent", color: "inherit", font: "500 14px var(--tp-font)" }}>
          <span aria-hidden style={{ flex: "none", width: 24, height: 24, borderRadius: 6, background: "#7c5cff" }} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{CLERK_STUB.org}</span>
        </button>
      }
      account={
        <>
          <button type="button" className="cl-userButtonTrigger" aria-label={CLERK_STUB.account} style={{ width: 34, height: 34, padding: 0, border: 0, borderRadius: "50%", background: "#3a4767" }} />
          <span className="tenant-api-status" role="status">{CLERK_STUB.status}</span>
        </>
      }
    />
  );
}
