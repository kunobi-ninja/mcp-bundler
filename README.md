# @kunobi/mcp-bundler

Connect to a remote HTTP MCP server and re-export its tools onto a local `McpServer`. Handles connection lifecycle, reconnection, and notifies when tools change.

## Install

```bash
npm install @kunobi/mcp-bundler
```

## Usage

```typescript
import { McpBundler } from '@kunobi/mcp-bundler';

const bundler = new McpBundler({
  name: 'my-server',
  url: 'http://127.0.0.1:3030/mcp',
  reconnect: { enabled: true, intervalMs: 5_000, maxRetries: Infinity },
});

bundler.on('connected', async () => {
  await bundler.registerTools(server);
  await bundler.registerResources(server);
  await bundler.registerPrompts(server, 'my-server__');
});

bundler.on('disconnected', () => {
  bundler.unregisterTools(server);
  bundler.unregisterResources(server);
  bundler.unregisterPrompts(server);
});

bundler.on('tools_changed', async () => {
  bundler.unregisterTools(server);
  await bundler.registerTools(server);
});

bundler.on('resources_changed', async () => {
  bundler.unregisterResources(server);
  await bundler.registerResources(server);
});

bundler.on('prompts_changed', async () => {
  bundler.unregisterPrompts(server);
  await bundler.registerPrompts(server, 'my-server__');
});

await bundler.connect();
```

## API

### `new McpBundler(options)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `name` | `string` | required | Identifier for logging |
| `url` | `string` | required | Remote MCP server HTTP URL |
| `reconnect.enabled` | `boolean` | `true` | Auto-reconnect on disconnect |
| `reconnect.intervalMs` | `number` | `5000` | Delay between reconnect attempts |
| `reconnect.maxRetries` | `number` | `Infinity` | Max reconnect attempts |
| `logger` | `function` | `console.error` | `(level, message, data?) => void` |

### Methods

#### Connection

- `connect()` — Connect to the remote server
- `close()` — Disconnect and stop reconnecting
- `getState()` — Get connection state (`idle`, `connecting`, `connected`, `disconnected`)

#### Tools

- `registerTools(server, prefix?)` — Register remote tools onto an `McpServer`
- `unregisterTools(server)` — Remove previously registered tools
- `listTools()` — Fetch current tool list from remote server
- `getTools()` — Get cached tool names

#### Resources

- `registerResources(server)` — Register remote resources onto an `McpServer`
- `unregisterResources(server)` — Remove previously registered resources
- `listResources()` — Fetch current resource list from remote server
- `getResources()` — Get cached resource URIs

#### Prompts

- `registerPrompts(server, prefix?)` — Register remote prompts onto an `McpServer`
- `unregisterPrompts(server)` — Remove previously registered prompts
- `listPrompts()` — Fetch current prompt list from remote server
- `getPrompts()` — Get cached prompt names

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
