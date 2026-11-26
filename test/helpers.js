import http from 'node:http';
import { createHandler } from '../supabase/functions/solo-dnd/core/handler.js';
import { MemoryStore } from '../supabase/functions/solo-dnd/core/store.js';
import { setDieRoller } from '../supabase/functions/solo-dnd/core/dice.js';

export const KEY = 'a'.repeat(32) + 'b'.repeat(32);

/** Serve the web-standard handler over real HTTP, like the Edge runtime does. */
export async function startServer(store = new MemoryStore(KEY)) {
  const handle = createHandler({ store, getAccessKey: () => store.getAccessKey() });
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://${req.headers.host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const response = await handle(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, store, mcpUrl: `${base}/functions/v1/solo-dnd/mcp/${KEY}` };
}

export async function withDice(value, fn) {
  const restore = setDieRoller(typeof value === 'function' ? value : () => value);
  try {
    return await fn();
  } finally {
    restore();
  }
}
