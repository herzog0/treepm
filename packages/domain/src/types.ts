export const TICKET_STATUSES = ["todo", "in_progress", "done"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export type AggregateStatus = "not_started" | "active" | "done";

export interface User {
  id: string;
  name: string;
  email: string;
  color: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  key: string;
  createdAt: string;
}

export interface TicketComponent {
  name: string;
  assigneeIds: string[];
}

export interface Ticket {
  id: string;
  projectId: string;
  sequence: number;
  parentId: string | null;
  title: string;
  description: string;
  status: TicketStatus;
  assigneeIds: string[];
  components: TicketComponent[];
  createdAt: string;
  updatedAt: string;
}

export type EdgeType = "hierarchy" | "dependency";

export interface EdgeStyle {
  color: string;
  width: number;
  dashed: boolean;
}

export interface TicketEdge {
  id: string;
  projectId: string;
  sourceId: string;
  targetId: string;
  type: EdgeType;
  style: EdgeStyle;
  metadata: Record<string, string>;
  createdAt: string;
}

export interface Database {
  projects: Project[];
  tickets: Ticket[];
  edges: TicketEdge[];
  users: User[];
}

export type BootstrapData = Database;

export interface Progress {
  doneLeaves: number;
  totalLeaves: number;
  percent: number;
  status: AggregateStatus;
  label: string;
}

export interface ChoiceLevel {
  depth: number;
  choice: string;
  label: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ClassificationSuggestion {
  mode: "available" | "unavailable" | "error";
  category: string | null;
  parentId: string | null;
  confidence: number;
  manualRequired: boolean;
  path: ChoiceLevel[];
  categoryProbabilities: Record<string, number>;
  message: string;
}
