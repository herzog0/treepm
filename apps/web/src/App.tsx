import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { buildTreeIndex } from "@treepm/domain";
import type { BootstrapData } from "@treepm/domain";
import { api } from "./api.js";
import { LegacyApp } from "./LegacyApp.js";
import { SpatialHome } from "./components/spatial/SpatialHome.js";

type Route = { path: string; search: string };

const currentRoute = (): Route => ({ path: window.location.pathname, search: window.location.search });

export function App() {
  const [data, setData] = useState<BootstrapData | null>(null);
  const [route, setRoute] = useState<Route>(currentRoute);
  const [error, setError] = useState("");
  const initialLoadRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const nextData = await api.bootstrap();
      startTransition(() => setData(nextData));
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Não foi possível carregar a API.");
    }
  }, []);

  useEffect(() => {
    if (initialLoadRef.current) return;
    initialLoadRef.current = true;
    void load();
  }, [load]);

  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((path: string) => {
    const nextPath = path === "/legacy" ? "/legacy" : "/";
    if (window.location.pathname !== nextPath) window.history.pushState({}, "", nextPath);
    setRoute({ path: nextPath, search: "" });
  }, []);

  const project = data?.projects[0];
  const tickets = useMemo(() => data?.tickets.filter((ticket) => ticket.projectId === project?.id) ?? [], [data, project?.id]);
  const treeIndex = useMemo(() => buildTreeIndex(tickets), [tickets]);
  const isLegacy = route.path === "/legacy" || route.path === "/legacy/";

  if (!project || !data) return <main className="loading-screen"><div className="brand-mark large">T</div><h1>TreePM</h1>{error ? <><p className="form-error">{error}</p><button className="button primary" onClick={() => void load()}>Tentar novamente</button></> : <p>Organizando o projeto…</p>}</main>;

  return isLegacy
    ? <LegacyApp key={route.search} data={data} onRefresh={load} onNavigateHome={() => navigate("/")} />
    : <SpatialHome project={project} tickets={tickets} treeIndex={treeIndex} users={data.users} onRefresh={load} onNavigateLegacy={() => navigate("/legacy")} />;
}
