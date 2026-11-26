import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer, KEY } from './helpers.js';

let srv;
before(async () => {
  srv = await startServer();
});
after(() => srv.server.close());

test('stays hidden: everything except the exact key URL is a bare 404', async () => {
  const paths = [
    '/', '/functions/v1/solo-dnd', '/functions/v1/solo-dnd/mcp', `/functions/v1/solo-dnd/mcp/${'x'.repeat(64)}`,
    '/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server', '/openapi.json', '/health',
  ];
  for (const p of paths) {
    for (const method of ['GET', 'POST']) {
      const res = await fetch(srv.base + p, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
      assert.equal(res.status, 404, `${method} ${p}`);
      assert.equal(await res.text(), 'Not found');
      assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
    }
  }
  const get = await fetch(srv.mcpUrl);
  assert.equal(get.status, 405);
});

test('a real MCP client can connect and play', async () => {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(srv.mcpUrl)));
  try {
    assert.match(client.getInstructions() ?? '', /getDmGuide/);
    assert.equal(client.getServerVersion().name, 'solo-adventure-engine');
    const { tools } = await client.listTools();
    assert.ok(tools.length >= 27);

    const guide = await client.callTool({ name: 'getDmGuide', arguments: {} });
    assert.match(guide.structuredContent.guide, /Dungeon Master/);

    const camp = await client.callTool({ name: 'createCampaign', arguments: { name: 'MCP Quest' } });
    const id = camp.structuredContent.id;
    const ch = await client.callTool({
      name: 'createCharacter',
      arguments: { campaignId: id, name: 'Bran', class: 'fighter', abilityScores: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 } },
    });
    assert.equal(ch.structuredContent.maxHp, 12);

    const check = await client.callTool({ name: 'makeCheck', arguments: { campaignId: id, kind: 'skill', skill: 'athletics', dc: 10 } });
    assert.ok(Number.isInteger(check.structuredContent.total));

    const bad = await client.callTool({ name: 'makeCheck', arguments: { campaignId: id, kind: 'skill', skill: 'juggling' } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Unknown skill/);

    const saved = await srv.store.get(id);
    assert.equal(saved.character.name, 'Bran');
  } finally {
    await client.close();
  }
});

test('ping, unknown method and bad JSON', async () => {
  const post = (body) => fetch(srv.mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body });
  assert.deepEqual((await (await post('{"jsonrpc":"2.0","id":1,"method":"ping"}')).json()).result, {});
  assert.equal((await (await post('{"jsonrpc":"2.0","id":2,"method":"nope"}')).json()).error.code, -32601);
  assert.equal((await post('{"jsonrpc":"2.0","method":"notifications/initialized"}')).status, 202);
  assert.equal((await post('not json')).status, 400);
  assert.ok(KEY.length >= 16);
});
