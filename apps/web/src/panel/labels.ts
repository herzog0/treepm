import type { ProjectRole, ProjectVisibility } from "../api/client.js";

export const ROLE_LABELS: Record<ProjectRole, string> = {
  manager: "Gestor",
  contributor: "Colaborador",
  reader: "Leitor",
};

export const ROLES: readonly ProjectRole[] = ["manager", "contributor", "reader"];

export const VISIBILITY_LABELS: Record<ProjectVisibility, string> = {
  organization: "Toda a organização",
  private: "Privado",
};

export const VISIBILITIES: readonly ProjectVisibility[] = ["organization", "private"];

export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
export const PROJECT_KEY_HELP =
  "A chave deve começar com uma letra maiúscula e ter de 2 a 10 caracteres, só letras maiúsculas e números.";
