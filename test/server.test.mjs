import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createBridgeServer } from '../server.mjs';
import { BattleBroker } from '../broker.mjs';

const token = 'test-only-token-with-at-least-24-characters';
async function fixture(t, options = {}) {
  const { http, broker } = createBridgeServer({ token, origins: ['http://tavern.test'], ...options });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${http.address().port}`;
  const post = async (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  t.after(async () => { broker.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  return { http, broker, base, post };
}
test('official MCP HTTP client discovers and calls the live panel bridge', async t => {
  const f = await fixture(t);
  const connection = await (await f.post('/bridge/connect', { label: 'TT test' }, { Origin: 'http://tavern.test' })).json();
  const client = new Client({ name: 'test-client', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(f.base + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  t.after(() => client.close());
  const list = await client.listTools();
  assert.equal(list.tools.length, 8);
  assert.equal(list.tools.find(t => t.name === 'battle_observe').annotations.readOnlyHint, true);
  assert.equal(list.tools.find(t => t.name === 'battle_click').annotations.readOnlyHint, false);
  const sessions = await client.callTool({ name: 'battle_sessions', arguments: {} });
  assert.equal(sessions.structuredContent.sessions[0].sessionId, connection.sessionId);
  const call = client.callTool({ name: 'battle_observe', arguments: { sessionId: connection.sessionId } });
  let polled;
  for (let i = 0; i < 40; i++) {
    polled = await (await f.post('/bridge/poll', connection)).json();
    if (polled.command) break;
    await new Promise(r => setTimeout(r, 5));
  }
  assert.equal(polled.command.operation, 'observe');
  assert.deepEqual(await (await f.post('/bridge/poll', connection)).json(), {});
  await f.post('/bridge/result', { ...connection, commandId: polled.command.id, result: { perspective: 'player', text: '我方回合', controls: [] } });
  const result = await call;
  assert.equal(result.structuredContent.text, '我方回合');
  const bad = await client.callTool({ name: 'battle_key', arguments: { ...connection, viewId: 'v', controlId: 'c', key: 'eval' } });
  assert.equal(bad.isError, true);
  await client.close();
});
test('pairing and origin checks protect browser and HTTP entry points', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/bridge/connect', {}, { Authorization: '' })).status, 401);
  assert.equal((await f.post('/mcp', {}, { Authorization: '' })).status, 401);
  assert.equal((await f.post('/bridge/connect', {}, { Origin: 'https://untrusted.example' })).status, 403);
  const cors = await fetch(f.base + '/bridge/poll', { method: 'OPTIONS', headers: { Origin: 'http://tavern.test' } });
  assert.equal(cors.headers.get('Access-Control-Allow-Origin'), 'http://tavern.test');
  assert.equal(cors.status, 204);
  assert.throws(() => createBridgeServer({ token: 'short' }), /24/);
});
test('a delivered timeout is not replayed; concurrent writes and late replies cannot resolve another command', async () => {
  const broker = new BattleBroker({ timeout: 40 });
  const { sessionId } = broker.connect('panel');
  const pending = broker.request(sessionId, 'click', {});
  const first = broker.poll(sessionId).command;
  assert.throws(() => broker.request(sessionId, 'click', {}), /另一项/);
  assert.deepEqual(broker.poll(sessionId), {});
  await assert.rejects(pending, /结果未知/);
  assert.deepEqual(broker.poll(sessionId), {});
  const next = broker.request(sessionId, 'observe', {});
  assert.equal(broker.result(sessionId, first.id, { ok: true }).accepted, false);
  const current = broker.poll(sessionId).command;
  broker.result(sessionId, current.id, { text: 'new' });
  assert.deepEqual(await next, { text: 'new' });
  broker.close();
});
test('stale and disconnected panels fail pending calls and are not selected implicitly', async () => {
  let now = 0;
  const broker = new BattleBroker({ now: () => now, staleAfter: 100 });
  const a = broker.connect('A'), b = broker.connect('B');
  const pending = broker.request(a.sessionId, 'click', {});
  broker.remove(a.sessionId);
  await assert.rejects(pending, /断开/);
  assert.equal(broker.list().length, 1);
  now = 101;
  assert.deepEqual(broker.list(), []);
  assert.throws(() => broker.poll(b.sessionId), /过期/);
});
test('cancelled undelivered requests cannot reach a later browser poll', async () => {
  const broker = new BattleBroker(); const {sessionId}=broker.connect('cancel');
  const aborter = new AbortController(); const pending=broker.request(sessionId,'click',{},aborter.signal);
  aborter.abort(); await assert.rejects(pending,/未送达/);
  assert.deepEqual(broker.poll(sessionId),{}); broker.close();
});
