import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected';

export interface ReconnectOptions {
  enabled: boolean;
  intervalMs: number;
  maxRetries: number;
}

export interface McpBundlerOptions {
  name: string;
  url: string;
  reconnect?: Partial<ReconnectOptions>;
  logger?: (level: string, message: string, data?: unknown) => void;
}

export interface McpBundlerEvents {
  connected: [];
  disconnected: [];
  tools_changed: [tools: Tool[]];
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}

function zodShapeFromJsonSchema(
  inputSchema: Tool['inputSchema'],
): z.ZodTypeAny {
  const properties = inputSchema?.properties as
    | Record<string, { description?: string }>
    | undefined;
  const required = (inputSchema?.required as string[]) || [];

  if (!properties || Object.keys(properties).length === 0) {
    return z.object({}).passthrough();
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, prop] of Object.entries(properties)) {
    let field: z.ZodTypeAny = z.any();
    if (prop?.description) {
      field = field.describe(prop.description);
    }
    if (!required.includes(name)) {
      field = field.optional();
    }
    shape[name] = field;
  }
  return z.object(shape).passthrough();
}

export class McpBundler extends EventEmitter<McpBundlerEvents> {
  public readonly name: string;

  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private readonly url: string;
  private readonly reconnectOpts: ReconnectOptions;
  private readonly logger: (
    level: string,
    message: string,
    data?: unknown,
  ) => void;

  private state: ConnectionState = 'idle';
  private retryCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private registeredToolNames: Set<string> = new Set();
  private lastToolNames: string[] = [];
  private closed = false;

  constructor(options: McpBundlerOptions) {
    super();
    this.name = options.name;
    this.url = options.url;
    this.logger = options.logger ?? (() => {});
    this.reconnectOpts = {
      enabled: options.reconnect?.enabled ?? true,
      intervalMs: options.reconnect?.intervalMs ?? 5_000,
      maxRetries: options.reconnect?.maxRetries ?? Number.POSITIVE_INFINITY,
    };
  }

  getState(): ConnectionState {
    return this.state;
  }

  getTools(): string[] {
    return [...this.lastToolNames];
  }

  async connect(): Promise<void> {
    if (this.closed) return;
    if (this.state === 'connecting' || this.state === 'connected') return;

    this.state = 'connecting';
    this.logger('info', `[${this.name}] Connecting to ${this.url}`);

    try {
      this.client = new Client(
        { name: `${this.name}-bundler`, version: '1.0.0' },
        { capabilities: {} },
      );

      this.transport = new StreamableHTTPClientTransport(new URL(this.url));

      this.transport.onclose = () => {
        if (this.state === 'connected') {
          this.handleDisconnect();
        }
      };

      this.transport.onerror = (error) => {
        this.logger('error', `[${this.name}] Transport error`, {
          error: formatError(error),
        });
      };

      await this.client.connect(this.transport);

      this.state = 'connected';
      this.retryCount = 0;
      this.logger('info', `[${this.name}] Connected`);

      const tools = await this.listTools();
      this.lastToolNames = tools.map((t) => t.name);

      this.emit('connected');
    } catch (error) {
      this.logger('error', `[${this.name}] Connection failed`, {
        error: formatError(error),
      });
      this.state = 'disconnected';
      this.scheduleReconnect();
    }
  }

  async listTools(): Promise<Tool[]> {
    if (!this.client || this.state !== 'connected') return [];
    try {
      const result = await this.client.listTools();
      return result.tools;
    } catch (error) {
      this.logger('error', `[${this.name}] Failed to list tools`, {
        error: formatError(error),
      });
      return [];
    }
  }

  async registerTools(server: McpServer): Promise<void> {
    const tools = await this.listTools();

    for (const tool of tools) {
      this.logger('info', `[${this.name}] Bundling tool: ${tool.name}`);

      const inputSchema = zodShapeFromJsonSchema(tool.inputSchema);

      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema,
        },
        async (args) => {
          this.logger('info', `[${this.name}] Forwarding call: ${tool.name}`);
          if (!this.client || this.state !== 'connected') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `[${this.name}] Not connected — cannot call ${tool.name}`,
                },
              ],
              isError: true,
            };
          }
          try {
            const result = await this.client.callTool({
              name: tool.name,
              arguments: args as Record<string, unknown>,
            });
            return result as CallToolResult;
          } catch (error) {
            const msg = formatError(error);
            this.logger(
              'error',
              `[${this.name}] Tool call failed: ${tool.name}`,
              { error: msg },
            );
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `[${this.name}] ${tool.name} failed: ${msg}`,
                },
              ],
              isError: true,
            };
          }
        },
      );

      this.registeredToolNames.add(tool.name);
    }
  }

  unregisterTools(server: McpServer): void {
    const serverAny = server as unknown as {
      _registeredTools: Record<string, { remove?: () => void }>;
    };
    if (!serverAny._registeredTools) return;

    for (const name of this.registeredToolNames) {
      const tool = serverAny._registeredTools[name];
      if (tool?.remove) {
        this.logger('info', `[${this.name}] Removing tool: ${name}`);
        tool.remove();
      }
    }
    this.registeredToolNames.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.client) {
      try {
        await this.client.close();
      } catch (error) {
        this.logger('warn', `[${this.name}] Error during close`, {
          error: formatError(error),
        });
      }
      this.client = null;
    }
    this.transport = null;
    this.state = 'idle';
  }

  private handleDisconnect(): void {
    this.state = 'disconnected';
    this.logger('info', `[${this.name}] Disconnected`);
    this.lastToolNames = [];
    this.emit('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (!this.reconnectOpts.enabled) return;
    if (this.retryCount >= this.reconnectOpts.maxRetries) {
      this.logger(
        'warn',
        `[${this.name}] Max retries (${this.reconnectOpts.maxRetries}) reached`,
      );
      return;
    }

    this.retryCount++;
    this.logger(
      'info',
      `[${this.name}] Reconnecting in ${this.reconnectOpts.intervalMs}ms (attempt ${this.retryCount})`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.state = 'idle';

      // Clean up old client
      if (this.client) {
        try {
          await this.client.close();
        } catch {
          // ignore close errors on stale client
        }
        this.client = null;
        this.transport = null;
      }

      await this.connect();

      // If reconnect succeeded and tools changed, emit tools_changed
      if ((this.state as ConnectionState) === 'connected') {
        const tools = await this.listTools();
        const newNames = tools.map((t) => t.name).sort();
        const oldNames = [...this.lastToolNames].sort();

        if (JSON.stringify(newNames) !== JSON.stringify(oldNames)) {
          this.lastToolNames = tools.map((t) => t.name);
          this.emit('tools_changed', tools);
        }
      }
    }, this.reconnectOpts.intervalMs);
  }
}
