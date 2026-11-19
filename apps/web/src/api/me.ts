export interface MeResponse {
  person: {
    id: string;
    displayName: string;
    email: string;
    avatarUrl: string | null;
  };
  organization: {
    orgId: string;
    name: string;
    slug: string;
  };
  roles: {
    clerk: "admin" | "member";
    teams: { teamId: string; role: "admin" | "member" }[];
    projects: { projectId: string; role: "manager" | "contributor" | "reader" }[];
  };
}

export type MeResult =
  | { status: "ok"; data: MeResponse }
  | { status: "unauthenticated" }
  | { status: "forbidden" }
  | { status: "unavailable" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMeResponse(value: unknown): value is MeResponse {
  if (!isRecord(value)) return false;

  const { person, organization, roles } = value;
  return (
    isRecord(person) &&
    typeof person.id === "string" &&
    typeof person.displayName === "string" &&
    typeof person.email === "string" &&
    (person.avatarUrl === null || typeof person.avatarUrl === "string") &&
    isRecord(organization) &&
    typeof organization.orgId === "string" &&
    typeof organization.name === "string" &&
    typeof organization.slug === "string" &&
    isRecord(roles) &&
    (roles.clerk === "admin" || roles.clerk === "member") &&
    Array.isArray(roles.teams) &&
    roles.teams.every((team: unknown) =>
      isRecord(team) &&
      typeof team.teamId === "string" &&
      (team.role === "admin" || team.role === "member")
    ) &&
    Array.isArray(roles.projects) &&
    roles.projects.every((project: unknown) =>
      isRecord(project) &&
      typeof project.projectId === "string" &&
      (project.role === "manager" || project.role === "contributor" || project.role === "reader")
    )
  );
}

export async function fetchMe(
  getToken: () => Promise<string | null>,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<MeResult> {
  try {
    const token = await getToken();
    if (!token) return { status: "unauthenticated" };

    const response = await fetchImpl("/api/me", {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.status === 401) return { status: "unauthenticated" };
    if (response.status === 403) return { status: "forbidden" };
    if (!response.ok) return { status: "unavailable" };

    const data: unknown = await response.json();
    return isMeResponse(data) ? { status: "ok", data } : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

export function getMeIndicatorText(result: MeResult | null): string | null {
  if (!result) return null;
  if (result.status === "ok") {
    return result.data.roles.clerk === "admin" ? "Administrador" : "Membro";
  }
  return result.status === "unavailable" ? "API indisponível" : "Sessão sem acesso à API";
}
