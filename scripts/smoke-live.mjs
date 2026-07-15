#!/usr/bin/env node
/**
 * Manual local smoke test — run THIS bundler build against a live MCP server
 * and assert re-exposed tools carry REAL param types (the old z.any() mapping
 * advertised every param as a typeless `{}`, which mangled typed args).
 *
 * Prereq: a running MCP server. For Kunobi, launch the desktop app and use the
 * variant port (local :3500, dev :3400, …). Then:
 *
 *   pnpm build && node scripts/smoke-live.mjs [url]
 *   node scripts/smoke-live.mjs http://127.0.0.1:3400/mcp     # dev variant
 *
 * Exits non-zero if the downstream is unreachable or if NO tool carries a typed
 * param (i.e. the type-preservation regressed back to typeless).
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpBundler, McpBundlerServerAdapter } from '../dist/index.js';

const url = process.argv[2] ?? 'http://127.0.0.1:3500/mcp';
const TYPED = /"type":\s*"(number|integer|boolean|array|object)"|"anyOf"|"const"/;

const bundler = new McpBundler({
  name: 'smoke',
  transport: { type: 'http', url },
  reconnect: { enabled: false },
  logger: (lvl, m) => lvl === 'error' && console.error('bundler:', m),
});
await bundler.connect();
const live = await bundler.listTools();
if (!live.length) {
  console.error(`No tools from ${url} — is the server running?`);
  process.exit(1);
}
console.log(`Connected to ${url} — ${live.length} downstream tools.`);

const server = new McpServer({ name: 'hub', version: '0' }, { capabilities: { tools: { listChanged: true } } });
await new McpBundlerServerAdapter(bundler, { toolPrefix: 'x__' }).registerTools(server);
const client = new Client({ name: 'smoke', version: '0' });
const [ct, st] = InMemoryTransport.createLinkedPair();
await Promise.all([server.server.connect(st), client.connect(ct)]);

const { tools } = await client.listTools();
let typedTools = 0;
let typedParams = 0;
for (const t of tools) {
  const props = t.inputSchema?.properties ?? {};
  const typed = Object.entries(props).filter(([, v]) => TYPED.test(JSON.stringify(v)));
  if (typed.length) {
    typedTools++;
    typedParams += typed.length;
  }
}
console.log(`Re-exposed ${tools.length} tools; ${typedTools} carry typed params (${typedParams} params total).`);
console.log('Under the old z.any() mapping every one of these would be advertised as {} (typeless).');
if (typedTools === 0) {
  console.error('FAIL: no typed params — type preservation regressed.');
  process.exit(1);
}
console.log('OK: type preservation holds against a live server.\n');

// ── Forward path: a real typed call round-trips to the live server ───────────
// If the downstream exposes Kunobi's read-only `app_events` (numeric `limit`),
// prove end-to-end that (a) a NUMBER forwards and the server accepts it, and
// (b) a STRINGIFIED number is now caught AT THE PROXY — the exact mangling that
// used to slip through and hit the server. Skipped gracefully otherwise.
const ae = tools.find((t) => t.name === 'x__app_events');
const limitTyped =
  ae && /"type":\s*\[?\s*"integer"|"type":\s*"integer"|"type":\s*"number"/.test(
    JSON.stringify(ae.inputSchema?.properties?.limit ?? {}),
  );
if (!ae || !limitTyped) {
  console.log('Forward-path check skipped (no app_events/limit numeric tool).');
  process.exit(0);
}
console.log('Forward path — calling app_events {action:"get", limit:3} through the bundler:');
const numeric = await client.callTool({
  name: 'x__app_events',
  arguments: { action: 'get', limit: 3 },
});
if (numeric.isError) {
  console.error('FAIL: a numeric limit was rejected/not forwarded:', JSON.stringify(numeric.content).slice(0, 120));
  process.exit(1);
}
console.log('  number 3 -> forwarded, server accepted. ok');

const stringified = await client.callTool({
  name: 'x__app_events',
  arguments: { action: 'get', limit: '3' },
});
if (!stringified.isError) {
  console.error('FAIL: a STRINGIFIED limit "3" was NOT caught at the proxy (the old bug).');
  process.exit(1);
}
console.log('  string "3" -> rejected at the proxy, never forwarded. ok');
console.log('\nOK: typed args round-trip; stringified args are caught before the server.');
process.exit(0);
