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
import { Demo } from "./demo/Demo.js";
import { Loading } from "./Loading.js";

function OrganizationGate({ appUrl }: { appUrl: string }) {
  const { isLoaded, isSignedIn, orgId } = useAuth();
  const { session } = useSession();

  if (!isLoaded) return <Loading />;

  if (session?.currentTask?.key === "choose-organization") {
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
        <strong>TreePM</strong>
        <div className="tenant-controls">
          <OrganizationSwitcher hidePersonal />
          <UserButton />
        </div>
      </header>
      <main className="tenant-map" key={orgId}>
        <Demo />
      </main>
    </div>
  );
}

export default function AuthenticatedApp({ publishableKey }: { publishableKey: string }) {
  const appUrl = window.location.pathname;

  return (
    <ClerkProvider
      publishableKey={publishableKey}
      localization={ptBR}
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
