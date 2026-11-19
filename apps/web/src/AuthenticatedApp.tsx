import {
  ClerkProvider,
  OrganizationList,
  OrganizationSwitcher,
  SignInButton,
  SignUpButton,
  TaskChooseOrganization,
  UserButton,
  useAuth,
  useSession,
} from "@clerk/react";
import { Demo } from "./demo/Demo.js";
import { Loading } from "./Loading.js";

function OrganizationGate() {
  const { isLoaded, isSignedIn, orgId } = useAuth();
  const { session } = useSession();

  if (!isLoaded) return <Loading />;

  if (session?.currentTask?.key === "choose-organization") {
    return (
      <main className="entry-screen">
        <h1>Escolha ou crie uma organização</h1>
        <TaskChooseOrganization redirectUrlComplete={window.location.pathname} />
      </main>
    );
  }

  if (!isSignedIn) {
    return (
      <main className="entry-screen">
        <h1>TreePM</h1>
        <div className="entry-actions">
          <SignInButton mode="modal"><button type="button">Entrar</button></SignInButton>
          <SignUpButton mode="modal"><button type="button">Criar conta</button></SignUpButton>
        </div>
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
  return (
    <ClerkProvider
      publishableKey={publishableKey}
      taskUrls={{ "choose-organization": window.location.pathname }}
    >
      <OrganizationGate />
    </ClerkProvider>
  );
}
