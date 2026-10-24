import { Mcp } from "@elitza/schema/mcp"

export const DEFAULT_MCP_SERVERS: Record<string, Mcp.ServerConfig> = {
  maton: {
    type: "remote",
    url: "https://mcp.maton.ai",
    codemode: true,
  },
  cloudflare: {
    type: "remote",
    url: "https://mcp.cloudflare.com/mcp",
    codemode: true,
  },
  github: {
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-github"],
    codemode: true,
  },
  filesystem: {
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-filesystem"],
    codemode: true,
  },
  memory: {
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-memory"],
    codemode: true,
  },
  fetch: {
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-fetch"],
    codemode: true,
  },
  postgres: {
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-postgres"],
    codemode: true,
  },
  sqlite: {
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-sqlite"],
    codemode: true,
  },
  slack: {
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-slack"],
    codemode: true,
  },
  time: {
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-time"],
    codemode: true,
  },
}

export function applyDefaultMcpServers(
  editor: { get: (name: string) => unknown; set: (name: string, config: Mcp.ServerConfig) => void },
): void {
  for (const [name, config] of Object.entries(DEFAULT_MCP_SERVERS)) {
    if (editor.get(name)) continue
    editor.set(name, config)
  }
}
