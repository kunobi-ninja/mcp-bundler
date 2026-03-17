import { EventEmitter } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  CallToolResult,
  GetPromptResult,
  Prompt,
  ReadResourceResult,
  Resource,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'disconnected';

export interface ReconnectOptions {
  enabled: boolean;
  intervalMs: number;
  maxRetries: number;
  operationTimeoutMs: number;
}

export type McpTransportConfig =
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | {
      type: 'stdio';
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

export interface McpBundlerOptions {
  name: string;
  transport: McpTransportConfig;
  reconnect?: Partial<ReconnectOptions>;
  logger?: (level: string, message: string, data?: unknown) => void;
}

export interface McpBundlerEvents {
  connected: [];
  disconnected: [];
  tools_changed: [tools: Tool[]];
  resources_changed: [resources: Resource[]];
  prompts_changed: [prompts: Prompt[]];
}

interface ConnectionWaiter {
  resolve: (connected: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return JSON.stringify(error);
}

function cloneDefinitions<T>(definitions: T[]): T[] {
  return definitions.map((definition) => structuredClone(definition));
}

/** Detect a 404 "session not found" HTTP error from the MCP SDK transport.
 *  Uses duck-typing so the bundler works even if the consumer's SDK version
 *  doesn't export StreamableHTTPError. */
function isSessionExpiredError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as { code: unknown }).code === 404
  );
}

export class McpBundler extends EventEmitter<McpBundlerEvents> {
  public readonly name: string;

  private client: Client | null = null;
  private activeTransport:
    | StreamableHTTPClientTransport
    | StdioClientTransport
    | null = null;
  private readonly transportConfig: McpTransportConfig;
  private readonly reconnectOpts: ReconnectOptions;
  private readonly logger: (
    level: string,
    message: string,
    data?: unknown,
  ) => void;

  private state: ConnectionState = 'idle';
  private retryCount = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTools: Tool[] = [];
  private lastResources: Resource[] = [];
  private lastPrompts: Prompt[] = [];
  private closed = false;
  private connectedAt: number | null = null;
  private successfulCalls = 0;
  private totalReconnects = 0;
  private connectionWaiters = new Set<ConnectionWaiter>();

  constructor(options: McpBundlerOptions) {
    super();
    this.name = options.name;
    this.transportConfig = options.transport;
    this.logger = options.logger ?? (() => {});
    this.reconnectOpts = {
      enabled: options.reconnect?.enabled ?? true,
      intervalMs: options.reconnect?.intervalMs ?? 5_000,
      maxRetries: options.reconnect?.maxRetries ?? Number.POSITIVE_INFINITY,
      operationTimeoutMs: options.reconnect?.operationTimeoutMs ?? 2_000,
    };
  }

  getState(): ConnectionState {
    return this.state;
  }

  getTools(): string[] {
    return this.lastTools.map((tool) => tool.name);
  }

  getResources(): string[] {
    return this.lastResources.map((resource) => resource.uri);
  }

  getPrompts(): string[] {
    return this.lastPrompts.map((prompt) => prompt.name);
  }

  getToolDefinitions(): Tool[] {
    return cloneDefinitions(this.lastTools);
  }

  getResourceDefinitions(): Resource[] {
    return cloneDefinitions(this.lastResources);
  }

  getPromptDefinitions(): Prompt[] {
    return cloneDefinitions(this.lastPrompts);
  }

  getDiagnostics(): {
    connectedAt: number | null;
    successfulCalls: number;
    totalReconnects: number;
    sessionUptimeMs: number | null;
  } {
    return {
      connectedAt: this.connectedAt,
      successfulCalls: this.successfulCalls,
      totalReconnects: this.totalReconnects,
      sessionUptimeMs: this.connectedAt ? Date.now() - this.connectedAt : null,
    };
  }

  private resolveConnectionWaiters(connected: boolean): void {
    for (const waiter of this.connectionWaiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(connected);
    }
    this.connectionWaiters.clear();
  }

  private waitForConnected(timeoutMs: number): Promise<boolean> {
    if (this.client && this.state === 'connected') {
      return Promise.resolve(true);
    }
    if (this.closed) {
      return Promise.resolve(false);
    }

    return new Promise((resolve) => {
      const waiter: ConnectionWaiter = {
        resolve,
        timer: setTimeout(() => {
          this.connectionWaiters.delete(waiter);
          resolve(this.client !== null && this.state === 'connected');
        }, timeoutMs),
      };
      this.connectionWaiters.add(waiter);
    });
  }

  private async ensureConnected(
    timeoutMs = this.reconnectOpts.operationTimeoutMs,
  ): Promise<boolean> {
    if (this.client && this.state === 'connected') {
      return true;
    }

    if (this.state === 'connecting') {
      return this.waitForConnected(timeoutMs);
    }

    if (this.state === 'idle' || this.state === 'disconnected') {
      await this.reconnectNow();
      if (this.client && this.getState() === 'connected') {
        return true;
      }
      if (this.getState() === 'connecting') {
        return this.waitForConnected(timeoutMs);
      }
    }

    return this.client !== null && this.state === 'connected';
  }

  async reconnectNow(): Promise<void> {
    if (this.closed) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.state === 'connecting') {
      this.logger(
        'info',
        `[${this.name}] reconnectNow skipped while a connection attempt is already in progress`,
      );
      return;
    }

    this.retryCount = 0;
    this.state = 'idle';

    if (this.client) {
      try {
        await this.client.close();
      } catch (error) {
        this.logger('warn', `[${this.name}] Error while forcing reconnect`, {
          error: formatError(error),
        });
      }
      this.client = null;
    }

    this.activeTransport = null;
    await this.connect();
  }

  async connect(): Promise<void> {
    if (this.closed) return;
    if (this.state === 'connecting' || this.state === 'connected') return;

    this.state = 'connecting';
    const target =
      this.transportConfig.type === 'http'
        ? this.transportConfig.url
        : `${this.transportConfig.command} ${(this.transportConfig.args ?? []).join(' ')}`;
    this.logger('info', `[${this.name}] Connecting to ${target}`);

    try {
      this.client = new Client(
        { name: `${this.name}-bundler`, version: '1.0.0' },
        {
          capabilities: {},
          listChanged: {
            tools: {
              autoRefresh: true,
              onChanged: (_err, tools) => {
                if (tools) {
                  this.lastTools = cloneDefinitions(tools);
                  this.emit('tools_changed', this.getToolDefinitions());
                }
              },
            },
            resources: {
              autoRefresh: true,
              onChanged: (_err, resources) => {
                if (resources) {
                  this.lastResources = cloneDefinitions(resources);
                  this.emit('resources_changed', this.getResourceDefinitions());
                }
              },
            },
            prompts: {
              autoRefresh: true,
              onChanged: (_err, prompts) => {
                if (prompts) {
                  this.lastPrompts = cloneDefinitions(prompts);
                  this.emit('prompts_changed', this.getPromptDefinitions());
                }
              },
            },
          },
        },
      );

      if (this.transportConfig.type === 'http') {
        const httpTransport = new StreamableHTTPClientTransport(
          new URL(this.transportConfig.url),
          this.transportConfig.headers
            ? { requestInit: { headers: this.transportConfig.headers } }
            : undefined,
        );
        httpTransport.onclose = () => {
          if (this.state === 'connected') {
            this.handleDisconnect();
          }
        };
        httpTransport.onerror = (error) => {
          this.logger('error', `[${this.name}] Transport error`, {
            error: formatError(error),
          });
          if (isSessionExpiredError(error) && this.state === 'connected') {
            const diag = this.getDiagnostics();
            this.logger(
              'warn',
              `[${this.name}] Session expired (uptime: ${diag.sessionUptimeMs ?? 0}ms, calls: ${diag.successfulCalls}). Reconnecting.`,
            );
            this.handleDisconnect();
          }
        };
        this.activeTransport = httpTransport;
      } else {
        const stdioTransport = new StdioClientTransport({
          command: this.transportConfig.command,
          args: this.transportConfig.args,
          env: this.transportConfig.env
            ? ({
                ...process.env,
                ...this.transportConfig.env,
              } as Record<string, string>)
            : undefined,
        });
        stdioTransport.onerror = (error) => {
          this.logger('error', `[${this.name}] Transport error`, {
            error: formatError(error),
          });
        };
        stdioTransport.onclose = () => {
          if (this.state === 'connected') {
            this.handleDisconnect();
          }
        };
        this.activeTransport = stdioTransport;
      }

      await this.client.connect(this.activeTransport);

      this.state = 'connected';
      this.connectedAt = Date.now();
      this.retryCount = 0;
      this.resolveConnectionWaiters(true);
      this.logger('info', `[${this.name}] Connected`);

      await this.listTools();
      await this.listResources();
      await this.listPrompts();

      this.emit('connected');
    } catch (error) {
      this.logger('error', `[${this.name}] Connection failed`, {
        error: formatError(error),
      });
      this.state = 'disconnected';
      this.resolveConnectionWaiters(false);
      this.scheduleReconnect();
    }
  }

  async listTools(): Promise<Tool[]> {
    if (!this.client || this.state !== 'connected') return [];
    try {
      const result = await this.client.listTools();
      this.lastTools = cloneDefinitions(result.tools);
      return this.getToolDefinitions();
    } catch (error) {
      this.logger('error', `[${this.name}] Failed to list tools`, {
        error: formatError(error),
      });
      return [];
    }
  }

  async listResources(): Promise<Resource[]> {
    if (!this.client || this.state !== 'connected') return [];
    const capabilities = this.client.getServerCapabilities();
    if (!capabilities?.resources) return [];
    try {
      const result = await this.client.listResources();
      this.lastResources = cloneDefinitions(result.resources);
      return this.getResourceDefinitions();
    } catch (error) {
      this.logger('error', `[${this.name}] Failed to list resources`, {
        error: formatError(error),
      });
      return [];
    }
  }

  async listPrompts(): Promise<Prompt[]> {
    if (!this.client || this.state !== 'connected') return [];
    const capabilities = this.client.getServerCapabilities();
    if (!capabilities?.prompts) return [];
    try {
      const result = await this.client.listPrompts();
      this.lastPrompts = cloneDefinitions(result.prompts);
      return this.getPromptDefinitions();
    } catch (error) {
      this.logger('error', `[${this.name}] Failed to list prompts`, {
        error: formatError(error),
      });
      return [];
    }
  }

  async callTool(
    name: string,
    arguments_: Record<string, unknown> = {},
  ): Promise<CallToolResult> {
    this.logger('info', `[${this.name}] Forwarding call: ${name}`);

    if (!(await this.ensureConnected())) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `[${this.name}] Not connected — cannot call ${name}. Automatic reconnect in progress — retry shortly or call kunobi_status.`,
          },
        ],
        isError: true,
      };
    }

    try {
      const result = (await this.client?.callTool({
        name,
        arguments: arguments_,
      })) as CallToolResult;
      this.successfulCalls++;
      return result;
    } catch (error) {
      if (isSessionExpiredError(error)) {
        const diag = this.getDiagnostics();
        this.logger(
          'warn',
          `[${this.name}] Session expired during ${name} (uptime: ${diag.sessionUptimeMs ?? 0}ms, calls: ${diag.successfulCalls}). Attempting reconnect + retry.`,
        );

        await this.reconnectNow();

        if (await this.ensureConnected()) {
          try {
            const retryResult = (await this.client?.callTool({
              name,
              arguments: arguments_,
            })) as CallToolResult;
            this.successfulCalls++;
            return retryResult;
          } catch (retryError) {
            const retryMsg = formatError(retryError);
            this.logger('error', `[${this.name}] Retry failed for ${name}`, {
              error: retryMsg,
            });
          }
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `[${this.name}] Session expired after ${Math.round((diag.sessionUptimeMs ?? 0) / 1000)}s (${diag.successfulCalls} successful calls). Reconnect + retry failed. Automatic reconnect in progress — retry shortly or call kunobi_status to check connectivity.`,
            },
          ],
          isError: true,
        };
      }

      const msg = formatError(error);
      this.logger('error', `[${this.name}] Tool call failed: ${name}`, {
        error: msg,
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `[${this.name}] ${name} failed: ${msg}`,
          },
        ],
        isError: true,
      };
    }
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    if (!(await this.ensureConnected())) {
      return {
        contents: [
          {
            uri,
            text: `[${this.name}] Not connected — cannot read ${uri}`,
          },
        ],
      };
    }

    const client = this.client;
    if (!client) {
      return {
        contents: [
          {
            uri,
            text: `[${this.name}] Not connected — cannot read ${uri}`,
          },
        ],
      };
    }

    try {
      return await client.readResource({ uri });
    } catch (error) {
      if (isSessionExpiredError(error)) {
        this.logger(
          'warn',
          `[${this.name}] Session expired while reading ${uri}`,
        );
        await this.reconnectNow();
        if (await this.ensureConnected()) {
          const retryClient = this.client;
          try {
            if (retryClient) {
              return await retryClient.readResource({ uri });
            }
          } catch (retryError) {
            const retryMsg = formatError(retryError);
            this.logger(
              'error',
              `[${this.name}] Resource retry failed: ${uri}`,
              {
                error: retryMsg,
              },
            );
          }
        }
      }

      const msg = formatError(error);
      this.logger('error', `[${this.name}] Resource read failed: ${uri}`, {
        error: msg,
      });
      return {
        contents: [
          {
            uri,
            text: `[${this.name}] ${uri} read failed: ${msg}`,
          },
        ],
      };
    }
  }

  async getPrompt(
    name: string,
    arguments_: Record<string, string> = {},
  ): Promise<GetPromptResult> {
    if (!(await this.ensureConnected())) {
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `[${this.name}] Not connected — cannot get prompt ${name}`,
            },
          },
        ],
      };
    }

    const client = this.client;
    if (!client) {
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `[${this.name}] Not connected — cannot get prompt ${name}`,
            },
          },
        ],
      };
    }

    try {
      return await client.getPrompt({
        name,
        arguments: arguments_,
      });
    } catch (error) {
      if (isSessionExpiredError(error)) {
        this.logger(
          'warn',
          `[${this.name}] Session expired while getting prompt ${name}`,
        );
        await this.reconnectNow();
        if (await this.ensureConnected()) {
          const retryClient = this.client;
          try {
            if (retryClient) {
              return await retryClient.getPrompt({
                name,
                arguments: arguments_,
              });
            }
          } catch (retryError) {
            const retryMsg = formatError(retryError);
            this.logger(
              'error',
              `[${this.name}] Prompt retry failed: ${name}`,
              {
                error: retryMsg,
              },
            );
          }
        }
      }

      const msg = formatError(error);
      this.logger('error', `[${this.name}] Prompt call failed: ${name}`, {
        error: msg,
      });
      return {
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: `[${this.name}] ${name} failed: ${msg}`,
            },
          },
        ],
      };
    }
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
    this.activeTransport = null;
    this.state = 'idle';
    this.resolveConnectionWaiters(false);
  }

  private handleDisconnect(): void {
    this.connectedAt = null;
    this.state = 'disconnected';
    this.logger('info', `[${this.name}] Disconnected`);
    this.emit('disconnected');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (!this.reconnectOpts.enabled) return;
    if (this.transportConfig.type === 'stdio') return;
    if (this.retryCount >= this.reconnectOpts.maxRetries) {
      this.logger(
        'warn',
        `[${this.name}] Max retries (${this.reconnectOpts.maxRetries}) reached`,
      );
      return;
    }

    this.retryCount++;
    this.totalReconnects++;

    const delay = Math.min(
      this.reconnectOpts.intervalMs * 1.5 ** (this.retryCount - 1),
      60_000,
    );

    this.logger(
      'info',
      `[${this.name}] Reconnecting in ${delay}ms (attempt ${this.retryCount})`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.state = 'idle';

      if (this.client) {
        try {
          await this.client.close();
        } catch {
          // ignore close errors on stale client
        }
        this.client = null;
        this.activeTransport = null;
      }

      await this.connect();
    }, delay);
  }
}

export * from './adapter.js';
