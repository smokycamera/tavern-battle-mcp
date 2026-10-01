import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { instructions } from './tools.mjs';

// Connect a local stdio consumer/tunnel to the SAME running broker used by the phone.
// Starting server.mjs --stdio instead would create an unrelated second broker.
async function main() {
  const token = process.env.TB_MCP_TOKEN;
  if (!token || token.length < 24) throw Error('Set TB_MCP_TOKEN to the running bridge token');
  const url = new URL(process.env.TB_MCP_URL || 'http://127.0.0.1:8766/mcp');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('Invalid TB_MCP_URL');
  const client = new Client({ name: 'tavern-battle-stdio-proxy', version: '0.1.0' });
  const server = new Server({ name: 'tavern-battle', version: '0.1.0' }, { capabilities: { tools: {} }, instructions });
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await Promise.allSettled([client.close(), server.close()]); };
  try {
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    server.setRequestHandler(ListToolsRequestSchema, (_request, extra) => client.listTools(undefined, { signal: extra.signal }));
    server.setRequestHandler(CallToolRequestSchema, (request, extra) => client.callTool(request.params, undefined, { signal: extra.signal }));
    server.onclose = () => { void close(); };
    await server.connect(new StdioServerTransport());
    process.stdin.once('end', () => { void close(); });
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close(); });
  } catch (error) { await close(); throw error; }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
