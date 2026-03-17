# @kunobi/mcp-bundler

Connect to a remote MCP server and cache its tools, resources, and prompts locally. The core `McpBundler` is transport-agnostic and handles connection lifecycle, metadata refresh, and reconnect-aware forwarding. An optional `McpBundlerServerAdapter` can re-export that remote metadata onto a local `McpServer`.

## Install

```bash
npm install @kunobi/mcp-bundler
```

## Usage

```typescript
import { McpBundler, McpBundlerServerAdapter } from '@kunobi/mcp-bundler';

const bundler = new McpBundler({
  name: 'my-server',
  transport: {
    type: 'http',
    url: 'http://127.0.0.1:3030/mcp',
  },
  reconnect: { enabled: true, intervalMs: 5_000, maxRetries: Infinity },
});

const adapter = new McpBundlerServerAdapter(bundler, {
  toolPrefix: 'my-server__',
  promptPrefix: 'my-server__',
  mapResource: (resource) => ({
    name: `my-server__${resource.name}`,
    uri: `my-server://resource/${encodeURIComponent(resource.uri)}`,
  }),
});

bundler.on('connected', async () => {
  await adapter.registerTools(server);
  await adapter.registerResources(server);
  await adapter.registerPrompts(server);
});

bundler.on('disconnected', () => {
  adapter.unregisterTools(server);
  adapter.unregisterResources(server);
  adapter.unregisterPrompts(server);
});

bundler.on('tools_changed', async () => {
  adapter.unregisterTools(server);
  await adapter.registerTools(server);
});

bundler.on('resources_changed', async () => {
  adapter.unregisterResources(server);
  await adapter.registerResources(server);
});

bundler.on('prompts_changed', async () => {
  adapter.unregisterPrompts(server);
  await adapter.registerPrompts(server);
});

await bundler.connect();
```

A stable proxy can keep the last-known registrations visible during short downstream disconnects and rely on `callTool` / `readResource` / `getPrompt` to reconnect on demand. If you want longer-lived surfaces, debounce unregisters in your adapter layer instead of removing everything on the first transport drop.

## API

### `new McpBundler(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | required | Identifier for logging |
| `transport` | `McpTransportConfig` | required | Downstream MCP transport config (`http` or `stdio`) |
| `reconnect.enabled` | `boolean` | `true` | Auto-reconnect on disconnect |
| `reconnect.intervalMs` | `number` | `5000` | Delay between reconnect attempts |
| `reconnect.maxRetries` | `number` | `Infinity` | Max reconnect attempts |
| `logger` | `function` | no-op | `(level, message, data?) => void` |

### Methods

#### Connection

- `connect()` — Connect to the remote server
- `reconnectNow()` — Cancel any pending reconnect timer and retry immediately
- `close()` — Disconnect and stop reconnecting
- `getState()` — Get connection state (`idle`, `connecting`, `connected`, `disconnected`)

#### Metadata and forwarding

- `listTools()` — Fetch current tool list from the downstream server
- `getToolDefinitions()` — Get cached full downstream tool definitions
- `getTools()` — Get cached tool names
- `callTool(name, args?)` — Forward a tool call directly to the downstream server
- `listResources()` — Fetch current resource list from the downstream server
- `getResourceDefinitions()` — Get cached full downstream resource definitions
- `getResources()` — Get cached resource URIs
- `readResource(uri)` — Read a downstream resource directly
- `listPrompts()` — Fetch current prompt list from the downstream server
- `getPromptDefinitions()` — Get cached full downstream prompt definitions
- `getPrompts()` — Get cached prompt names
- `getPrompt(name, args?)` — Fetch a downstream prompt directly

### `new McpBundlerServerAdapter(bundler, options?)`

Use the optional server adapter when you want to re-register a bundled server onto a local `McpServer`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `toolPrefix` | `string` | `""` | Prefix applied to re-exported tool names |
| `promptPrefix` | `string` | `""` | Prefix applied to re-exported prompt names |
| `mapToolName` | `(tool) => string` | — | Full control over the local tool name |
| `mapPromptName` | `(prompt) => string` | — | Full control over the local prompt name |
| `mapResource` | `(resource) => { name, uri, ... }` | identity | Full control over the local resource name and URI |

### Adapter methods

- `registerTools(server)` — Register cached downstream tools on a local `McpServer`
- `unregisterTools(server)` — Remove the tools previously registered by this adapter
- `registerResources(server)` — Register cached downstream resources on a local `McpServer`
- `unregisterResources(server)` — Remove the resources previously registered by this adapter
- `registerPrompts(server)` — Register cached downstream prompts on a local `McpServer`
- `unregisterPrompts(server)` — Remove the prompts previously registered by this adapter

### Events

- `connected` — Connection established
- `disconnected` — Connection lost
- `tools_changed` — Remote tool list changed
- `resources_changed` — Remote resource list changed
- `prompts_changed` — Remote prompt list changed

All three `*_changed` events are driven by MCP `listChanged` notifications — the bundler subscribes to downstream servers and auto-refreshes when they signal changes.

## Development

```bash
pnpm install
pnpm build
pnpm test
```
