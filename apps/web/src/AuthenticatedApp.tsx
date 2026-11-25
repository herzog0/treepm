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
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { writeActAs } from "./api/actAs.js";
import { createApiClient } from "./api/client.js";
import { fetchMe } from "./api/me.js";
import type { MeResult } from "./api/me.js";
import { GITHUB_CALLBACK_PATH, GithubCallback } from "./github/GithubCallback.js";
import { clerkLocalization } from "./i18n/clerk.js";
import { LanguageSync } from "./i18n/LanguageSync.js";
import type { Language } from "./i18n/languages.js";
import { LegalFooter } from "./legal/LegalFooter.js";
import { Loading } from "./Loading.js";
import { ActAsProvider, useActAs } from "./people/ActAs.js";
import { ClerkPreferencesProvider } from "./preferences/ClerkPreferences.js";
import { ChatShell } from "./chat/ChatShell.js";
import { ChatsProvider } from "./chat/ChatsContext.js";
import { chatTicketTarget, useView } from "./nav/navigation.js";
import { Sidebar } from "./nav/Sidebar.js";
import type { CommandRequest } from "./map/commandRequest.js";
import { Workspace } from "./Workspace.js";

function meIndicatorKey(result: MeResult | null) {
  if (!result) return null;
  if (result.status === "ok") return result.data.roles.clerk === "admin" ? "meIndicator.admin" : "meIndicator.member";
  return result.status === "unavailable" ? "meIndicator.unavailable" : "meIndicator.noAccess";
}

function MeIndicator({ getToken }: { getToken: () => Promise<string | null> }) {
  const { t } = useTranslation();
  const { acting } = useActAs();
  const actingId = acting?.id ?? null;
  const [result, setResult] = useState<MeResult | null>(null);

  useEffect(() => {
    let active = true;
    void fetchMe(getToken, undefined, actingId).then((response) => {
      if (active) setResult(response);
    });
    return () => {
      active = false;
    };
  }, [getToken, actingId]);

  const key = meIndicatorKey(result);
  return <span className="tenant-api-status" role="status">{key && t(key)}</span>;
}

function OrganizationGate({ appUrl }: { appUrl: string }) {
  const { t } = useTranslation();
  const { isLoaded, isSignedIn, orgId, getToken } = useAuth();
  const { session } = useSession();
  const { acting, leave } = useActAs();
  const actingId = acting?.id ?? null;
  const [view, navigate, projectId, ticketId, openTicket, focusId, clearFocus] = useView();
  // O GitHub devolve o navegador para /github/callback (ADR 0032); a tela de retorno ocupa o lugar do mapa até a pessoa sair dela.
  const [onGithubCallback, setOnGithubCallback] = useState(() => window.location.pathname === GITHUB_CALLBACK_PATH);
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const callbackClient = useMemo(() => createApiClient({ getToken: () => getTokenRef.current(), actAsId: actingId }), [actingId]);
  // Trocar de organização descarta o ticket aberto (ADR 0026): o ID não existe na outra.
  const previousOrgId = useRef(orgId);
  useEffect(() => {
    if (previousOrgId.current && orgId && previousOrgId.current !== orgId && ticketId !== null) openTicket(null);
    previousOrgId.current = orgId;
  }, [orgId, ticketId, openTicket]);
  // O "entrar como" é de uma organização e de uma sessão: trocar de organização ou sair da conta o encerra (e limpa o que a aba guardou).
  const actOrgId = useRef(orgId);
  useEffect(() => {
    const changedOrg = actOrgId.current !== orgId && actOrgId.current !== undefined && actOrgId.current !== null;
    actOrgId.current = orgId;
    if (actingId !== null && (changedOrg || (isLoaded && !isSignedIn))) leave();
    else if (isLoaded && !isSignedIn) writeActAs(null);
  }, [orgId, isLoaded, isSignedIn, actingId, leave]);
  // "Novo ticket" e "Buscar" da barra lateral falam com a barra de pedidos do mapa: o pedido espera o mapa montar e vale uma vez.
  const [commandRequest, setCommandRequest] = useState<CommandRequest | null>(null);
  const requestCommand = (kind: CommandRequest["kind"]) => {
    setCommandRequest((current) => ({ kind, id: (current?.id ?? 0) + 1 }));
    if (view !== "map") navigate("map");
  };
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
        <h1>{t("chooseOrganization")}</h1>
        <TaskChooseOrganization redirectUrlComplete={appUrl} />
      </main>
    );
  }

  if (!isSignedIn) {
    const isSignUp = new URLSearchParams(window.location.search).get("auth") === "sign-up";
    return (
      <main className="entry-screen">
        <h1>{t("brand")}</h1>
        {isSignUp ? <SignUp routing="hash" /> : <SignIn routing="hash" />}
        <LegalFooter />
      </main>
    );
  }

  if (!orgId) {
    return (
      <main className="entry-screen">
        <h1>{t("chooseOrganization")}</h1>
        <OrganizationList hidePersonal />
        <UserButton />
      </main>
    );
  }

  return (
    // Trocar de organização descarta o painel de chats (e o que ele guarda): os chats são da organização.
    <ChatsProvider key={orgId} client={callbackClient} onShowTicket={(id) => navigate("map", null, chatTicketTarget(ticketId, id))}>
      <ChatShell
        sidebar={
          <Sidebar
            view={view}
            onNavigate={navigate}
            onNewTicket={() => requestCommand("new")}
            onSearch={() => requestCommand("search")}
            organization={<OrganizationSwitcher hidePersonal />}
            account={
              <>
                <UserButton />
                <MeIndicator key={orgId} getToken={getToken} />
              </>
            }
          />
        }
      >
        {onGithubCallback ? (
          <main className="tenant-settings">
            <GithubCallback
              client={callbackClient}
              onOpenSettings={() => {
                setOnGithubCallback(false);
                navigate("settings", null, { section: "github" });
              }}
            />
          </main>
        ) : (
          <Workspace orgId={orgId} view={view} projectId={projectId} onNavigate={navigate} ticketId={ticketId} onOpenTicket={openTicket} focusTicketId={focusId} onFocusHandled={clearFocus} commandRequest={commandRequest} onCommandHandled={() => setCommandRequest(null)} getToken={getToken} />
        )}
      </ChatShell>
    </ChatsProvider>
  );
}

export default function AuthenticatedApp({ publishableKey }: { publishableKey: string }) {
  // O idioma ativo vem da preferência da pessoa (dentro do Clerk) ou do navegador; a tradução do Clerk o acompanha.
  const { i18n } = useTranslation();
  // Entrar pela volta do GitHub não faz de /github/callback a raiz da aplicação para os redirecionamentos do Clerk.
  const appUrl = window.location.pathname === GITHUB_CALLBACK_PATH ? "/" : window.location.pathname;

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      localization={clerkLocalization(i18n.language as Language)}
      signInUrl={appUrl}
      signUpUrl={`${appUrl}?auth=sign-up`}
      signInFallbackRedirectUrl={appUrl}
      signUpFallbackRedirectUrl={appUrl}
      afterSignOutUrl={appUrl}
      taskUrls={{ "choose-organization": `${appUrl}?auth=choose-organization` }}
    >
      <ActAsProvider>
        <ClerkPreferencesProvider>
          <LanguageSync />
          <OrganizationGate appUrl={appUrl} />
        </ClerkPreferencesProvider>
      </ActAsProvider>
    </ClerkProvider>
  );
}
