import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createBridgeServer } from '../server.mjs';

test('stdio proxy discovers the same phone session and forwards tool calls to the existing broker', async () => {
  const token='proxy-test-only-token-with-more-than-24-characters';
  const {http,broker}=createBridgeServer({token});
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const {sessionId}=broker.connect('phone');
  const client=new Client({name:'tunnel-test',version:'1'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../stdio-proxy.mjs',import.meta.url))],
      env:{...process.env,TB_MCP_TOKEN:token,TB_MCP_URL:`http://127.0.0.1:${http.address().port}/mcp`},stderr:'pipe'}));
    assert.equal((await client.listTools()).tools.length,16);
    const sessions=await client.callTool({name:'battle_sessions',arguments:{}});
    assert.equal(sessions.structuredContent.sessions[0].sessionId,sessionId);
    const result=client.callTool({name:'battle_observe',arguments:{sessionId}});
    let command;
    for(let i=0;i<100;i++){command=broker.poll(sessionId).command;if(command)break;await new Promise(r=>setTimeout(r,5));}
    assert.equal(command.operation,'observe');
    broker.result(sessionId,command.id,{text:'手机玩家视角',controls:[]});
    assert.equal((await result).structuredContent.text,'手机玩家视角');
  } finally { await client.close();broker.close();http.closeAllConnections();await new Promise(resolve=>http.close(resolve)); }
});
