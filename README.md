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
});

bundler.on('disconnected', () => {
  bundler.unregisterTools(server);
});

bundler.on('tools_changed', async () => {
  bundler.unregisterTools(server);
  await bundler.registerTools(server);
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

- `connect()` — Connect to the remote server
- `close()` — Disconnect and stop reconnecting
- `registerTools(server)` — Register remote tools onto an `McpServer`
- `unregisterTools(server)` — Remove previously registered tools
- `listTools()` — Get currently available remote tools
- `getTools()` — Get cached tool list
- `getState()` — Get connection state (`idle`, `connecting`, `connected`, `disconnected`)

### Events

- `connected` — Connection established
- `disconnected` — Connection lost
- `tools_changed` — Remote tool list changed (after reconnect)

## Development

```bash
pnpm install
pnpm build
pnpm test
```
