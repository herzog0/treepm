import type { ProjectRole, ProjectVisibility } from "../api/client.js";

export const ROLES: readonly ProjectRole[] = ["manager", "contributor", "reader"];

export const VISIBILITIES: readonly ProjectVisibility[] = ["organization", "private"];

export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
