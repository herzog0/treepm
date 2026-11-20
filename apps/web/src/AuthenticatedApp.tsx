import { ptBR } from "@clerk/localizations/pt-BR";
import {
  ClerkProvider,
  OrganizationList,
  OrganizationSwitcher,
  SignIn,
  SignUp,
  TaskChooseOrganization,
  UserButton,
  useAuth,
  useSession,
} from "@clerk/react";
import { useEffect, useRef, useState } from "react";
import { fetchMe, getMeIndicatorText } from "./api/me.js";
import type { MeResult } from "./api/me.js";
import { Loading } from "./Loading.js";
import { ClerkPreferencesProvider } from "./preferences/ClerkPreferences.js";
import { AppNav, useView } from "./nav/navigation.js";
import { Workspace } from "./Workspace.js";

const localization = {
  ...ptBR,
  formFieldInputPlaceholder__signUpPassword: "Crie uma senha",
} satisfies typeof ptBR;

function MeIndicator({ getToken }: { getToken: () => Promise<string | null> }) {
  const [result, setResult] = useState<MeResult | null>(null);

  useEffect(() => {
    let active = true;
    void fetchMe(getToken).then((response) => {
      if (active) setResult(response);
    });
    return () => {
      active = false;
    };
  }, [getToken]);

  return <span className="tenant-api-status" role="status">{getMeIndicatorText(result)}</span>;
}

function OrganizationGate({ appUrl }: { appUrl: string }) {
  const { isLoaded, isSignedIn, orgId, getToken } = useAuth();
  const { session } = useSession();
  const [view, navigate, projectId, ticketId, openTicket] = useView();
  // Trocar de organização descarta o ticket aberto (ADR 0026): o ID não existe na outra.
  const previousOrgId = useRef(orgId);
  useEffect(() => {
    if (previousOrgId.current && orgId && previousOrgId.current !== orgId && ticketId !== null) openTicket(null);
    previousOrgId.current = orgId;
  }, [orgId, ticketId, openTicket]);
  const mustChooseOrganization = session?.currentTask?.key === "choose-organization";

  useEffect(() => {
    if (!isLoaded || !isSignedIn || !orgId || mustChooseOrganization) return;

    const url = new URL(window.location.href);
    if (!url.searchParams.has("auth")) return;

    url.searchParams.delete("auth");
    window.history.replaceState(window.history.state, "", url);
  }, [isLoaded, isSignedIn, orgId, mustChooseOrganization]);

  if (!isLoaded) return <Loading />;

  if (mustChooseOrganization) {
    return (
      <main className="entry-screen">
        <h1>Escolha ou crie uma organização</h1>
        <TaskChooseOrganization redirectUrlComplete={appUrl} />
      </main>
    );
  }

  if (!isSignedIn) {
    const isSignUp = new URLSearchParams(window.location.search).get("auth") === "sign-up";
    return (
      <main className="entry-screen">
        <h1>TreePM</h1>
        {isSignUp ? <SignUp routing="hash" /> : <SignIn routing="hash" />}
      </main>
    );
  }

  if (!orgId) {
    return (
      <main className="entry-screen">
        <h1>Escolha ou crie uma organização</h1>
        <OrganizationList hidePersonal />
        <UserButton />
      </main>
    );
  }

  return (
    <div className="tenant-shell">
      <header className="tenant-header">
        <div className="tenant-brand">
          <strong>TreePM</strong>
          <AppNav view={view} onNavigate={navigate} />
        </div>
        <div className="tenant-controls">
          <OrganizationSwitcher hidePersonal />
          <MeIndicator key={orgId} getToken={getToken} />
          <UserButton />
        </div>
      </header>
      <ClerkPreferencesProvider>
        <Workspace orgId={orgId} view={view} projectId={projectId} onNavigate={navigate} ticketId={ticketId} onOpenTicket={openTicket} getToken={getToken} />
      </ClerkPreferencesProvider>
    </div>
  );
}

export default function AuthenticatedApp({ publishableKey }: { publishableKey: string }) {
  const appUrl = window.location.pathname;

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      localization={localization}
      signInUrl={appUrl}
      signUpUrl={`${appUrl}?auth=sign-up`}
      signInFallbackRedirectUrl={appUrl}
      signUpFallbackRedirectUrl={appUrl}
      afterSignOutUrl={appUrl}
      taskUrls={{ "choose-organization": `${appUrl}?auth=choose-organization` }}
    >
      <OrganizationGate appUrl={appUrl} />
    </ClerkProvider>
  );
}
