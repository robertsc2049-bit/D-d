import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/app.js';

const KEY = 'mcp-test-key';
let server;
let base;

before(async () => {
  const app = createApp({ store: new Store(null), apiKey: KEY });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function connect(path) {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + path)));
  return client;
}

const parse = (r) => JSON.parse(r.content[0].text);

test('rejects a wrong key', async () => {
  await assert.rejects(() => connect('/mcp/wrong'));
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
});

test('lists tools and plays through the MCP endpoint', async () => {
  const client = await connect(`/mcp/${KEY}`);
  try {
    assert.match(client.getInstructions() ?? '', /getDmGuide/);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['getDmGuide', 'createCampaign', 'createCharacter', 'makeCheck', 'startCombat', 'combatAttack']) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
    assert.equal(tools.find((t) => t.name === 'getCampaign').annotations.readOnlyHint, true);
    assert.equal(tools.find((t) => t.name === 'deleteCampaign').annotations.destructiveHint, true);

    const guide = await client.callTool({ name: 'getDmGuide', arguments: {} });
    assert.match(guide.content[0].text, /Dungeon Master/);

    const camp = parse(await client.callTool({ name: 'createCampaign', arguments: { name: 'MCP Quest' } }));
    const ch = parse(await client.callTool({
      name: 'createCharacter',
      arguments: { campaignId: camp.id, name: 'Bran', class: 'fighter', abilityScores: { str: 16, dex: 12, con: 14, int: 10, wis: 12, cha: 8 } },
    }));
    assert.equal(ch.maxHp, 12);

    const check = await client.callTool({ name: 'makeCheck', arguments: { campaignId: camp.id, kind: 'skill', skill: 'athletics', dc: 10 } });
    assert.equal(check.isError, undefined);
    assert.ok(Number.isInteger(check.structuredContent.total));

    const state = parse(await client.callTool({ name: 'getCampaign', arguments: { campaignId: camp.id, journalEntries: 3 } }));
    assert.equal(state.character.name, 'Bran');

    const bad = await client.callTool({ name: 'makeCheck', arguments: { campaignId: camp.id, kind: 'skill', skill: 'juggling' } });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, /Unknown skill/);
  } finally {
    await client.close();
  }
});

test('also accepts the key as a Bearer header', async () => {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${KEY}` } },
  }));
  const { tools } = await client.listTools();
  assert.ok(tools.length > 20);
  await client.close();
});

test('OAuth discovery probes get 404, not 401', async () => {
  for (const p of ['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource/mcp/${KEY}`, '/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 404, p);
  }
});
