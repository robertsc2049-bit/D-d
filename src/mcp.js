// MCP (Model Context Protocol) endpoint, for ChatGPT plugins / custom MCP connectors and other MCP clients.
// The tools are generated from the OpenAPI spec, and each call is forwarded to the matching REST route,
// so both ways of connecting share exactly the same rules and validation.
import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { buildSpec } from './openapi.js';

const GUIDE_FILE = new URL('../gpt/instructions.md', import.meta.url);
export const DM_GUIDE = fs.existsSync(GUIDE_FILE) ? fs.readFileSync(GUIDE_FILE, 'utf8') : '';

const SERVER_INSTRUCTIONS = `These tools are the dice, rules engine and saved memory for a solo tabletop RPG where you are the Dungeon Master. Call getDmGuide once at the start of every conversation and follow it. Never invent dice results: always roll with these tools.`;

/** Turn every OpenAPI operation into an MCP tool definition plus the info needed to call it. */
function buildTools() {
  const spec = buildSpec('http://internal');
  const tools = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (method === 'parameters') continue;
      const properties = {};
      const required = [];
      const pathParams = [];
      const queryParams = [];
      for (const p of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        properties[p.name] = { ...p.schema, description: p.description };
        if (p.required) required.push(p.name);
        (p.in === 'path' ? pathParams : queryParams).push(p.name);
      }
      const bodySchema = op.requestBody?.content?.['application/json']?.schema;
      if (bodySchema) {
        Object.assign(properties, bodySchema.properties);
        if (op.requestBody.required) required.push(...(bodySchema.required ?? []));
      }
      tools.push({
        definition: {
          name: op.operationId,
          title: op.summary,
          description: op.description,
          inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}) },
          annotations: {
            title: op.summary,
            readOnlyHint: method === 'get',
            destructiveHint: method === 'delete',
            openWorldHint: false,
          },
        },
        method: method.toUpperCase(),
        path,
        pathParams,
        queryParams,
        hasBody: Boolean(bodySchema),
      });
    }
  }
  return tools;
}

const TOOLS = buildTools();
const GUIDE_TOOL = {
  name: 'getDmGuide',
  title: 'Read the Dungeon Master guide',
  description: 'Returns the full Dungeon Master rules and play guide for these tools. Call this once at the start of each conversation, before anything else.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { title: 'Read the Dungeon Master guide', readOnlyHint: true, openWorldHint: false },
};

export const MCP_TOOL_NAMES = [GUIDE_TOOL.name, ...TOOLS.map((t) => t.definition.name)];

function createMcpServer({ baseUrl, apiKey }) {
  const server = new Server(
    { name: 'solo-adventure-engine', title: 'Solo Adventure Engine', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [GUIDE_TOOL, ...TOOLS.map((t) => t.definition)],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    if (name === GUIDE_TOOL.name) return { content: [{ type: 'text', text: DM_GUIDE }] };

    const tool = TOOLS.find((t) => t.definition.name === name);
    if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool "${name}".` }] };

    const rest = { ...args };
    let url = tool.path;
    for (const p of tool.pathParams) {
      if (rest[p] === undefined || rest[p] === '') {
        return { isError: true, content: [{ type: 'text', text: `"${p}" is required.` }] };
      }
      url = url.replace(`{${p}}`, encodeURIComponent(String(rest[p])));
      delete rest[p];
    }
    const query = new URLSearchParams();
    for (const q of tool.queryParams) {
      if (rest[q] !== undefined) query.set(q, String(rest[q]));
      delete rest[q];
    }
    if ([...query].length) url += `?${query}`;

    const res = await fetch(baseUrl + url, {
      method: tool.method,
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: tool.hasBody || tool.method === 'POST' ? JSON.stringify(rest) : undefined,
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    const result = {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      ...(res.ok && data && typeof data === 'object' && !Array.isArray(data) ? { structuredContent: data } : {}),
    };
    if (!res.ok) result.isError = true;
    return result;
  });

  return server;
}

/** Express handler for the stateless Streamable HTTP MCP transport. */
export function mcpHandler({ apiKey }) {
  return async (req, res) => {
    const baseUrl = `http://127.0.0.1:${req.socket.localPort}`;
    const server = createMcpServer({ baseUrl, apiKey });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
