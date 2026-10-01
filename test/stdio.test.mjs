import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('official stdio client initializes a separate server process with clean protocol output', async () => {
  const reserve = createServer(); await new Promise(r=>reserve.listen(0,'127.0.0.1',r));
  const port = String(reserve.address().port); await new Promise(r=>reserve.close(r));
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../server.mjs',import.meta.url)),'--stdio'],
    env: { ...process.env, TB_MCP_PORT: port, TB_MCP_TOKEN: 'stdio-test-only-random-token-with-enough-length' }, stderr: 'pipe' });
  const client = new Client({name:'stdio-test',version:'1'});
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length,8);
    const result=await client.callTool({name:'battle_sessions',arguments:{}});
    assert.deepEqual(result.structuredContent,{sessions:[]});
  } finally { await client.close(); }
});
