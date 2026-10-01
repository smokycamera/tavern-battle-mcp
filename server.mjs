import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BattleBroker } from './broker.mjs';
import { createBattleMcp } from './tools.mjs';

function equal(a, b) {
  const x = Buffer.from(a || ''), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function json(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw Error('Request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export function createBridgeServer({ token, origins = [], broker = new BattleBroker(), httpMcp = true, allowUnauthenticatedMcp = false }) {
  if (!token || token.length < 24) throw Error('TB_MCP_TOKEN 至少需要24个字符');
  const transports = new Set();
  const http = createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const origin = req.headers.origin;
      if (origin && !origins.includes(origin)) return reply(403, { error: 'Origin 未授权；把酒馆页面的 origin 加入 TB_MCP_ORIGINS' });
      if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST,GET,DELETE,OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,MCP-Protocol-Version,Mcp-Session-Id');
        res.setHeader('Access-Control-Allow-Private-Network', 'true');
        res.writeHead(204); return res.end();
      }
      if (path === '/health') return reply(200, { service: 'tavern-battle-mcp', protocol: 1 });
      // A trusted authenticated tunnel may terminate MCP auth. Browser bridge auth is always required.
      if (!(path === '/mcp' && allowUnauthenticatedMcp) && !equal(req.headers.authorization, 'Bearer ' + token)) return reply(401, { error: 'Invalid bearer token' });
      if (path === '/mcp' && httpMcp) {
        if (req.method !== 'POST') return reply(405, { error: 'Use Streamable HTTP POST' });
        const body = await json(req);
        const server = createBattleMcp(broker);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        transports.add(transport);
        res.on('close', () => { transports.delete(transport); void transport.close(); void server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      if (req.method !== 'POST') return reply(405, { error: 'POST required' });
      const body = await json(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Invalid request');
      if (path === '/bridge/connect') return reply(200, broker.connect(body.label));
      if (typeof body.sessionId !== 'string') throw Error('sessionId required');
      if (path === '/bridge/poll') return reply(200, broker.poll(body.sessionId));
      if (path === '/bridge/result') return reply(200, broker.result(body.sessionId, body.commandId, body.result));
      if (path === '/bridge/disconnect') { broker.remove(body.sessionId); return reply(200, { disconnected: true }); }
      reply(404, { error: 'Unknown endpoint' });
    } catch (e) { if (!res.headersSent) reply(400, { error: e.message }); else res.end(); }
  });
  http.on('close', () => { broker.close(); for (const transport of transports) void transport.close(); });
  return { http, broker };
}

async function main() {
  const stdio = process.argv.includes('--stdio');
  const token = process.env.TB_MCP_TOKEN || randomBytes(32).toString('base64url');
  const host = process.env.TB_MCP_HOST || '127.0.0.1';
  const port = Number(process.env.TB_MCP_PORT || 8766);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid TB_MCP_PORT');
  const origins = (process.env.TB_MCP_ORIGINS || 'http://localhost:8000,http://127.0.0.1:8000,http://tauri.localhost,https://tauri.localhost,tauri://localhost').split(',').map(x => x.trim()).filter(Boolean);
  const tunnelAuth = process.env.TB_MCP_AUTHENTICATED_TUNNEL === '1';
  if (tunnelAuth && host !== '127.0.0.1' && host !== '::1') throw Error('Authenticated tunnel mode must bind to loopback');
  const { http, broker } = createBridgeServer({ token, origins, httpMcp: !stdio, allowUnauthenticatedMcp: tunnelAuth });
  await new Promise((resolve, reject) => { http.once('error', reject); http.listen(port, host, resolve); });
  console.error(`战阵桥接: http://${host}:${port}\nMCP: ${stdio ? 'stdio' : `http://${host}:${port}/mcp`}\n酒馆 Origin: ${origins.join(', ')}`);
  if (!process.env.TB_MCP_TOKEN) console.error(`本次配对密钥（填入酒馆设置）: ${token}`);
  let mcp;
  if (stdio) { mcp = createBattleMcp(broker); await mcp.connect(new StdioServerTransport()); process.stdin.on('end', () => http.close()); }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { broker.close(); http.close(); void mcp?.close(); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error(e.message); process.exitCode = 1; });
