// The MCP server the runner serves each agent's Corral tools on. Agent CLIs
// name its tools mcp__<server>__<tool> in their transcripts.
export const CORRAL_MCP_SERVER = 'corral'

const PREFIX = `mcp__${CORRAL_MCP_SERVER}__`

// A transcript's tool name without the Corral server's prefix
export function corralToolName(tool: string): string {
  return tool.startsWith(PREFIX) ? tool.slice(PREFIX.length) : tool
}
