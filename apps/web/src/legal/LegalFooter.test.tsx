import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Tela de entrada de quem não está autenticado: o Clerk é trocado por peças simples.
vi.mock("@clerk/react", () => ({
  ClerkProvider: ({ children }: { children: unknown }) => <>{children as never}</>,
  SignIn: () => <p>sign in form</p>,
  SignUp: () => <p>sign up form</p>,
  OrganizationList: () => null,
  OrganizationSwitcher: () => null,
  TaskChooseOrganization: () => null,
  UserButton: () => null,
  useAuth: () => ({ isLoaded: true, isSignedIn: false, orgId: null, getToken: async () => null }),
  useSession: () => ({ session: null }),
  useUser: () => ({ isLoaded: true, user: null }),
  useClerk: () => ({}),
}));

import AuthenticatedApp from "../AuthenticatedApp.js";

describe("legal footer on the sign-in screen", () => {
  it("links to the terms and to the privacy policy", async () => {
    // Sem sessão o idioma segue o navegador; o jsdom diz "en".
    vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["pt-BR"]);
    render(<AuthenticatedApp publishableKey="pk_test_x" />);
    expect(await screen.findByText("sign in form")).toBeInTheDocument();
    const footer = screen.getByRole("navigation", { name: "Documentos legais" });
    expect(within(footer).getByRole("link", { name: "Termos de uso" })).toHaveAttribute("href", "/termos");
    expect(within(footer).getByRole("link", { name: "Política de privacidade" })).toHaveAttribute("href", "/privacidade");
  });
});
