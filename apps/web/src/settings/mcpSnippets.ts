/** Trechos de configuração de cada cliente de IA (ADR 0038). São código, não texto de interface: não vão para o catálogo. */

export type SnippetBlockId = "command" | "mcpJson" | "configToml" | "envVariable";
export interface SnippetBlock {
  id: SnippetBlockId;
  text: string;
}
export type SnippetClient = "claudeCode" | "cursor" | "codex";
export const SNIPPET_CLIENTS: readonly SnippetClient[] = ["claudeCode", "cursor", "codex"];

/** O endereço do servidor MCP de um projeto, na mesma origem da página. */
export const mcpAddress = (origin: string, projectKey: string): string => `${origin}/api/mcp/${projectKey}`;

export function snippetsFor(client: SnippetClient, address: string, projectKey: string, token: string): SnippetBlock[] {
  const name = `treepm-${projectKey.toLowerCase()}`;
  switch (client) {
    case "claudeCode":
      return [{ id: "command", text: `claude mcp add --transport http ${name} ${address} --header "Authorization: Bearer ${token}"` }];
    case "cursor":
      return [
        {
          id: "mcpJson",
          text: JSON.stringify({ mcpServers: { [name]: { url: address, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
        },
      ];
    case "codex":
      return [
        { id: "configToml", text: `[mcp_servers.${name}]\nurl = "${address}"\nbearer_token_env_var = "TREEPM_MCP_TOKEN"` },
        { id: "envVariable", text: `export TREEPM_MCP_TOKEN="${token}"` },
      ];
  }
}
