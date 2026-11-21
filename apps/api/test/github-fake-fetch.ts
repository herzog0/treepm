// Fetch falso do GitHub: nenhuma chamada sai da máquina; as respostas são JSON gravado à mão.
export type Call = { method: string; url: string; headers: Record<string, string> };
export type Route = { status?: number; body?: unknown; link?: string; etag?: string };

export function fakeFetch(routes: Record<string, Route | Route[]>) {
  const calls: Call[] = [];
  const impl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : null;
    const url = request?.url ?? String(input);
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? request?.headers).forEach((value, key) => (headers[key] = value));
    calls.push({ method, url, headers });
    const path = url.replace("https://api.github.com", "").replace("https://github.com", "");
    const key = `${method} ${path.split("?")[0]}`;
    const entry = routes[key];
    if (!entry) return Promise.reject(new Error(`rota não prevista no teste: ${key}`));
    const route = Array.isArray(entry) ? (entry.shift() ?? entry[0]) : entry;
    if (!route) return Promise.reject(new Error("sem resposta"));
    const headers2: Record<string, string> = { "content-type": "application/json; charset=utf-8", date: new Date().toUTCString() };
    if (route.link) headers2["link"] = route.link;
    if (route.etag) headers2["etag"] = route.etag;
    const status = route.status ?? 200;
    const response = new Response(status === 304 ? null : JSON.stringify(route.body ?? {}), { status, headers: headers2 });
    // `Response.url` é vazio em respostas sintéticas; o octokit usa a URL para normalizar a paginação.
    Object.defineProperty(response, "url", { value: url });
    return Promise.resolve(response);
  };
  return { impl: impl as typeof fetch, calls };
}

