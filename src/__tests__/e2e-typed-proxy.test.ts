import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it, vi } from 'vitest';
import { McpBundler, McpBundlerServerAdapter } from '../index.js';

/**
 * End-to-end proof for kunobi-frontend#2565, over a REAL MCP client↔server pair
 * (in-memory transport). Proves the two claims the unit tests can't:
 *
 *  (1) the re-exposed variant tool is ADVERTISED upstream with real param types
 *      (not the typeless schema the old `z.any()` mapping produced), and
 *  (2) typed args AND null field-clearing forward to the bundler intact — i.e.
 *      the fix works end-to-end and doesn't regress clearing.
 *
 * The tool schema below is verbatim-shaped from the live schemars output for
 * `agentgateway__proxy_add` / `proxy_update` — the exact tool that produced the
 * original bogus SCHEMA_INVALID.
 */

function proxyAddTool(): Tool {
  return {
    name: 'proxy_add',
    description: 'Create an LLM proxy',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name' },
        port: {
          type: 'integer',
          format: 'uint16',
          description: 'Loopback port',
        },
        auto_start: { type: 'boolean', description: 'Start on boot' },
        provider_ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Provider UUIDs',
        },
        // Option<u64> — schemars encodes as a nullable type-array.
        request_timeout_secs: {
          type: ['integer', 'null'],
          description: 'Optional timeout',
        },
        // Option<String> — clearable via null.
        rate_limit_id: {
          type: ['string', 'null'],
          description: 'Optional rate-limit UUID',
        },
      },
      required: ['name', 'port'],
    },
  } as Tool;
}

async function linkedPair(bundler: McpBundler) {
  const server = new McpServer(
    { name: 'hub', version: '0.0.1' },
    { capabilities: { tools: { listChanged: true } } },
  );
  const adapter = new McpBundlerServerAdapter(bundler, { toolPrefix: 'local__' });
  await adapter.registerTools(server);

  const client = new Client({ name: 'agent', version: '0.0.1' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return { server, client };
}

describe('e2e: proxied tool advertises real types and forwards them intact', () => {
  it('(1) upstream tools/list advertises real param types, not a typeless schema', async () => {
    const bundler = new McpBundler({
      name: 'local',
      transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      reconnect: { enabled: false },
      logger: () => {},
    });
    vi.spyOn(bundler, 'listTools').mockResolvedValue([proxyAddTool()]);

    const { client } = await linkedPair(bundler);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'local__proxy_add');
    expect(tool).toBeDefined();

    const props = tool?.inputSchema?.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    // The core assertion: types survived to the advertised schema. Under the
    // old z.any() mapping these were all `{}` (no type), which is what let the
    // client stringify scalars.
    // A real numeric type survives (the core fix) — `number`, not the old
    // typeless `{}`. Deliberately NOT `integer`: mapping integer→z.number()
    // (rather than z.number().int()) is what avoids the uint64 regression, at
    // the cost of the nominal integer keyword. Downstream still enforces uint*.
    expect(props?.port?.type).toBe('number');
    expect(props?.auto_start?.type).toBe('boolean');
    expect(props?.provider_ids?.type).toBe('array');
    expect((props?.provider_ids?.items as { type?: unknown })?.type).toBe(
      'string',
    );
    // The nullable Option<String> is advertised as a real string|null union
    // (zod serializes the union as anyOf), so `null` clearing stays legal.
    const anyOf = props?.rate_limit_id?.anyOf as
      | Array<{ type?: unknown }>
      | undefined;
    const rlTypes = (anyOf ?? []).map((m) => m.type);
    expect(rlTypes).toContain('string');
    expect(rlTypes).toContain('null');
  });

  it('(2) a typed call forwards correctly-typed values to the bundler', async () => {
    const bundler = new McpBundler({
      name: 'local',
      transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      reconnect: { enabled: false },
      logger: () => {},
    });
    vi.spyOn(bundler, 'listTools').mockResolvedValue([proxyAddTool()]);
    const callTool = vi
      .spyOn(bundler, 'callTool')
      .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    const { client } = await linkedPair(bundler);
    await client.callTool({
      name: 'local__proxy_add',
      arguments: {
        name: 'gw',
        port: 8080,
        auto_start: true,
        provider_ids: ['a', 'b'],
      },
    });

    // Forwarded to the downstream variant with types intact — a number stays a
    // number, a boolean stays a boolean, the array stays an array. This is what
    // used to arrive stringified and get rejected.
    expect(callTool).toHaveBeenCalledWith('proxy_add', {
      name: 'gw',
      port: 8080,
      auto_start: true,
      provider_ids: ['a', 'b'],
    });
  });

  it('(2b) null field-clearing still forwards (regression guard for Option<T>)', async () => {
    const bundler = new McpBundler({
      name: 'local',
      transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      reconnect: { enabled: false },
      logger: () => {},
    });
    vi.spyOn(bundler, 'listTools').mockResolvedValue([proxyAddTool()]);
    const callTool = vi
      .spyOn(bundler, 'callTool')
      .mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    const { client } = await linkedPair(bundler);
    await client.callTool({
      name: 'local__proxy_add',
      arguments: { name: 'gw', port: 8080, rate_limit_id: null },
    });

    // `null` reaches the variant unchanged — the clear path is preserved.
    expect(callTool).toHaveBeenCalledWith('proxy_add', {
      name: 'gw',
      port: 8080,
      rate_limit_id: null,
    });
  });
});
