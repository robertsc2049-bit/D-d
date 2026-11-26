// HTTP + MCP (Model Context Protocol, Streamable HTTP, stateless JSON mode) handler.
// Web-standard Request -> Response, so it runs unchanged on Supabase Edge (Deno) and in Node tests.
//
// Public routes: POST .../mcp/<access key> (MCP) and POST .../sync/<access key> (push the ledger to GitHub;
// called by a database cron job). Everything else, and any wrong key, gets a bare 404, so the server
// reveals nothing to visitors or scanners.
import { listTools, callTool } from './tools.js';
import { syncAll } from './mirror.js';

const SERVER_INFO = { name: 'solo-adventure-engine', title: 'Solo Adventure Engine', version: '2.0.0' };
const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const INSTRUCTIONS = 'These tools are the dice, rules engine and saved memory for a solo tabletop RPG in which you are the Dungeon Master. '
  + 'Call getDmGuide once at the start of every conversation and follow it. Never invent dice results: always roll with these tools.';

const HIDDEN_HEADERS = { 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };

const notFound = () => new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain', ...HIDDEN_HEADERS } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...HIDDEN_HEADERS } });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function handleMessage(msg, ctx) {
  if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return rpcError(msg?.id, -32600, 'Invalid JSON-RPC request.');
  }
  const isNotification = msg.id === undefined || msg.id === null;
  if (isNotification) return null; // e.g. notifications/initialized: nothing to send back

  const { id, method, params = {} } = msg;
  switch (method) {
    case 'initialize': {
      const requested = params.protocolVersion;
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: listTools() } };
    case 'tools/call': {
      if (typeof params.name !== 'string') return rpcError(id, -32602, 'tools/call needs a tool "name".');
      const r = await callTool(params.name, params.arguments ?? {}, ctx);
      const payload = r.ok ? r.data : { error: r.error };
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(payload) }],
          ...(r.ok && payload && typeof payload === 'object' && !Array.isArray(payload) ? { structuredContent: payload } : {}),
          ...(r.ok ? {} : { isError: true }),
        },
      };
    }
    default:
      return rpcError(id, -32601, `Method not supported: ${method}`);
  }
}

/**
 * createHandler({ store, getAccessKey }) -> (Request) => Promise<Response>
 * store: campaign storage. getAccessKey: async () => the secret key that must appear in the URL.
 * github: optional GitHub client for mirroring the ledger.
 * @param {{ store: any, getAccessKey: () => any, github?: any, log?: (line: string) => void }} options
 */
export function createHandler({ store, getAccessKey, github = null, log = (_line) => {} }) {
  return async function handle(req) {
    const url = new URL(req.url);
    const match = url.pathname.match(/\/(mcp|sync)\/([A-Za-z0-9_-]{16,128})\/?$/);
    if (!match) return notFound();
    const [, route, givenKey] = match;

    let key;
    try {
      key = await getAccessKey();
    } catch (e) {
      log(`access key unavailable: ${e.message}`);
      return json({ error: 'Server is not configured yet.' }, 503);
    }
    if (!key || !safeEqual(givenKey, key)) return notFound();

    if (req.method !== 'POST') {
      return new Response(null, { status: 405, headers: { allow: 'POST', ...HIDDEN_HEADERS } });
    }

    if (route === 'sync') {
      const results = await syncAll(store, github);
      log(`sync -> ${JSON.stringify(results).slice(0, 300)}`);
      return json({ results });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return json(rpcError(null, -32700, 'Request body is not valid JSON.'), 400);
    }

    const ctx = { store, github };
    const started = Date.now();
    let response;
    if (Array.isArray(body)) {
      const results = (await Promise.all(body.map((m) => handleMessage(m, ctx)))).filter(Boolean);
      response = results.length ? json(results) : new Response(null, { status: 202, headers: HIDDEN_HEADERS });
    } else {
      const result = await handleMessage(body, ctx);
      response = result ? json(result) : new Response(null, { status: 202, headers: HIDDEN_HEADERS });
    }
    const what = Array.isArray(body) ? 'batch' : `${body?.method ?? '?'}${body?.params?.name ? `:${body.params.name}` : ''}`;
    log(`${what} -> ${response.status} (${Date.now() - started}ms)`);
    return response;
  };
}
