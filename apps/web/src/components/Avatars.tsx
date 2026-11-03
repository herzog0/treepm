import type { User } from "@treepm/domain";

export function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
}

export function Avatars({ userIds, users, compact = false }: { userIds: string[]; users: User[]; compact?: boolean }) {
  const assigned = userIds.map((id) => users.find((user) => user.id === id)).filter((user) => user !== undefined);
  if (assigned.length === 0) return <span className="unassigned">Sem responsável</span>;
  return (
    <div className={`avatars ${compact ? "avatars-compact" : ""}`} aria-label={`Responsáveis: ${assigned.map((user) => user.name).join(", ")}`}>
      {assigned.slice(0, 4).map((user) => (
        <span className="avatar" key={user.id} style={{ backgroundColor: user.color }} title={user.name} aria-hidden="true">
          {initials(user.name)}
        </span>
      ))}
      {assigned.length > 4 && <span className="avatar avatar-more">+{assigned.length - 4}</span>}
    </div>
  );
}
