import { useState } from "react";
import { childrenOf, descendantsOf, getProjectProgress, ticketIdentifier } from "@treepm/domain";
import type { Ticket } from "@treepm/domain";
import type { PrototypeData } from "./shared.js";
import { personInitials, statusInfo } from "./shared.js";

export function VariantC({ project, tickets, users }: PrototypeData) {
  const root = childrenOf(tickets, null)[0];
  const branches = root ? childrenOf(tickets, root.id) : childrenOf(tickets, null);
  const [information, setInformation] = useState(1);
  const [geometry, setGeometry] = useState(1);
  const [selectedBranch, setSelectedBranch] = useState(branches[0]?.id ?? "");
  const projectProgress = getProjectProgress(tickets);
  const informationLabel = ["tudo completo", "profundos compactos", "chips e status", "somente faixas"][information];

  const goToBranch = (id: string) => {
    setSelectedBranch(id);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById(`proto-c-${id}`)?.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "nearest", inline: "center" });
  };

  return <div className="proto-c">
    <div className="proto-statebar">
      <div><span>DOIS CONTROLES INDEPENDENTES</span><strong>Projeto › {branches.find((ticket) => ticket.id === selectedBranch)?.title ?? "todas as faixas"}</strong></div>
      <div className="proto-state-metrics"><span>informação: {informationLabel}</span><span>câmera: {Math.round(geometry * 100)}%</span><span>{branches.length} faixas · {tickets.length} tickets representados</span></div>
    </div>
    <div className="proto-c-controls">
      <label><span>NÍVEL DA INFORMAÇÃO <output>{information}/3</output></span><input type="range" min="0" max="3" step="1" value={information} onChange={(event) => setInformation(Number(event.target.value))} /><small>Muda conteúdo e relayout, não a câmera</small></label>
      <div className="proto-c-root"><span>{root ? ticketIdentifier(root, project.key) : project.key}</span><strong>{root?.title ?? project.name}</strong><small>{projectProgress.label}</small></div>
      <label><span>ZOOM GEOMÉTRICO <output>{Math.round(geometry * 100)}%</output></span><input type="range" min="0.7" max="1.5" step="0.05" value={geometry} onChange={(event) => setGeometry(Number(event.target.value))} /><small>Amplia o que está visível, sem mudar a semântica</small></label>
    </div>
    <div className="proto-c-minimap" aria-label="Minimapa das subárvores">{branches.map((branch) => {
      const info = statusInfo(tickets, branch);
      return <button key={branch.id} className={selectedBranch === branch.id ? "active" : ""} onClick={() => goToBranch(branch.id)}><i className={`proto-status-${info.status}`} style={{ width: `${Math.max(12, info.progress.percent)}%` }} /><span>{branch.title}</span></button>;
    })}</div>
    <div className="proto-c-viewport">
      <div className="proto-c-lanes" style={{ transform: `scale(${geometry})`, width: `${branches.length * 292}px` }}>
        {branches.map((branch) => <BranchLane key={branch.id} branch={branch} allTickets={tickets} users={users} projectKey={project.key} information={information} selected={selectedBranch === branch.id} onSelect={() => setSelectedBranch(branch.id)} />)}
      </div>
    </div>
    <div className="proto-c-help">Scroll navega pelas faixas · cada slider mantém o outro estado intacto</div>
  </div>;
}

function BranchLane({ branch, allTickets, users, projectKey, information, selected, onSelect }: {
  branch: Ticket;
  allTickets: Ticket[];
  users: PrototypeData["users"];
  projectKey: string;
  information: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const descendants = descendantsOf(allTickets, branch.id);
  const branchInfo = statusInfo(allTickets, branch);
  return <section id={`proto-c-${branch.id}`} className={`proto-c-lane ${selected ? "selected" : ""}`} aria-label={`Subárvore ${branch.title}`}>
    <button className={`proto-c-branch proto-status-${branchInfo.status}`} onClick={onSelect}>
      <span>{ticketIdentifier(branch, projectKey)}</span><strong>{branch.title}</strong><small>{descendants.length} descendentes · {branchInfo.label}</small><div><i style={{ width: `${branchInfo.progress.percent}%` }} /></div>
    </button>
    <div className={`proto-c-items ${information >= 2 ? "compressed" : ""}`}>
      {descendants.map((ticket) => {
        const depth = ticketPathDepth(allTickets, ticket, branch.id);
        const kind = information === 0 ? "full" : information === 1 ? (depth <= 1 ? "full" : "compact") : information === 2 ? (depth <= 0 ? "compact" : depth === 1 ? "chip" : "dot") : "dot";
        const info = statusInfo(allTickets, ticket);
        return <button key={ticket.id} className={`proto-c-ticket proto-card-${kind} proto-status-${info.status}`} style={{ marginLeft: kind === "dot" ? 0 : Math.min(depth, 3) * 10 }} title={`${ticket.title} — ${info.label}`} aria-label={`${ticket.title}. ${info.label}`}>
          {kind === "dot" ? <span className="proto-sr-only">{ticket.title}</span> : <>
            <span className="proto-card-key">{ticketIdentifier(ticket, projectKey)}</span><strong>{ticket.title}</strong>
            {kind === "full" && <span className="proto-card-people">{personInitials(ticket.assigneeIds, users) || "Sem responsável"}</span>}
            <span className="proto-card-progress">{info.label}</span><span className="proto-mini-track"><i style={{ width: `${info.progress.percent}%` }} /></span>
          </>}
        </button>;
      })}
    </div>
    <footer>{descendants.length} representados · {branchInfo.progress.percent}% do ramo</footer>
  </section>;
}

function ticketPathDepth(tickets: Ticket[], ticket: Ticket, branchId: string): number {
  let depth = 0;
  let current = ticket;
  const visited = new Set<string>();
  while (current.parentId && current.id !== branchId && !visited.has(current.id)) {
    visited.add(current.id);
    depth += 1;
    current = tickets.find((item) => item.id === current.parentId) ?? current;
    if (current.id === ticket.id) break;
  }
  return Math.max(0, depth - 1);
}
