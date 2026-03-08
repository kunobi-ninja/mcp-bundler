import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  Prompt,
  Resource,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatError, McpBundler, McpBundlerServerAdapter } from '../index.js';

type ServerInternals = {
  _registeredPrompts: Record<
    string,
    { remove?: () => void; handler?: (args: unknown) => Promise<unknown> }
  >;
  _registeredResources: Record<string, { remove?: () => void }>;
  _registeredTools: Record<
    string,
    { remove?: () => void; handler?: (args: unknown) => Promise<unknown> }
  >;
};

function createBundler(): McpBundler {
  return new McpBundler({
    name: 'test',
    transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
    reconnect: { enabled: false },
    logger: () => {},
  });
}

function createServer(): McpServer {
  return new McpServer(
    { name: 'test', version: '0.0.1' },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { subscribe: true, listChanged: true },
        prompts: { listChanged: true },
      },
    },
  );
}

describe('formatError', () => {
  it('extracts message from Error instances', () => {
    expect(formatError(new Error('boom'))).toBe('boom');
  });

  it('returns strings as-is', () => {
    expect(formatError('something went wrong')).toBe('something went wrong');
  });

  it('JSON-stringifies other types', () => {
    expect(formatError({ code: 42 })).toBe('{"code":42}');
    expect(formatError(null)).toBe('null');
    expect(formatError(123)).toBe('123');
  });
});

describe('McpBundler core', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
  });

  it('starts in idle state with empty cached metadata', () => {
    const bundler = createBundler();
    expect(bundler.getState()).toBe('idle');
    expect(bundler.getTools()).toEqual([]);
    expect(bundler.getResources()).toEqual([]);
    expect(bundler.getPrompts()).toEqual([]);
    expect(bundler.getToolDefinitions()).toEqual([]);
    expect(bundler.getResourceDefinitions()).toEqual([]);
    expect(bundler.getPromptDefinitions()).toEqual([]);
  });

  it('transitions to disconnected on connection failure', async () => {
    const bundler = createBundler();
    await bundler.connect();
    expect(bundler.getState()).toBe('disconnected');
    await bundler.close();
  });

  it('does not connect when already closed', async () => {
    const bundler = createBundler();
    await bundler.close();
    await bundler.connect();
    expect(bundler.getState()).toBe('idle');
  });

  it('prevents duplicate connect calls', async () => {
    const bundler = createBundler();
    const p1 = bundler.connect();
    const p2 = bundler.connect();
    await Promise.all([p1, p2]);
    expect(bundler.getState()).toBe('disconnected');
    await bundler.close();
  });

  it('close is idempotent', async () => {
    const bundler = createBundler();
    await bundler.close();
    await bundler.close();
    expect(bundler.getState()).toBe('idle');
  });

  it('reconnectNow cancels the pending timer and forces one immediate retry', async () => {
    const bundler = new McpBundler({
      name: 'reconnect-now-test',
      transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      reconnect: { enabled: true, intervalMs: 10_000, maxRetries: 5 },
      logger: () => {},
    });

    const connectSpy = vi.spyOn(bundler, 'connect');

    await bundler.connect();
    expect(bundler.getState()).toBe('disconnected');
    expect(connectSpy).toHaveBeenCalledTimes(1);

    await bundler.reconnectNow();

    expect(connectSpy).toHaveBeenCalledTimes(2);
    await bundler.close();
  });

  it('does not schedule reconnect for stdio transport', async () => {
    const logMessages: string[] = [];
    const bundler = new McpBundler({
      name: 'stdio-no-reconnect',
      transport: { type: 'stdio', command: 'false' },
      reconnect: { enabled: true, intervalMs: 10, maxRetries: 5 },
      logger: (_level, message) => logMessages.push(message),
    });

    await bundler.connect();
    expect(bundler.getState()).toBe('disconnected');
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      logMessages.some((message) => message.includes('Reconnecting')),
    ).toBe(false);

    await bundler.close();
  });

  it('callTool forwards to the connected client', async () => {
    const bundler = createBundler();
    const bundlerAny = bundler as unknown as {
      client: { callTool: ReturnType<typeof vi.fn> };
      state: 'connected';
    };
    bundlerAny.client = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'forwarded' }],
      }),
    };
    bundlerAny.state = 'connected';

    const result = await bundler.callTool('k8s', { action: 'list' });

    expect(bundlerAny.client.callTool).toHaveBeenCalledWith({
      name: 'k8s',
      arguments: { action: 'list' },
    });
    expect(result.content[0].text).toBe('forwarded');
  });

  it('returns connection errors for direct forwarding while disconnected', async () => {
    const bundler = createBundler();

    const toolResult = await bundler.callTool('k8s');
    const resourceResult = await bundler.readResource('kunobi://status');
    const promptResult = await bundler.getPrompt('setup');

    expect(toolResult.isError).toBe(true);
    expect(toolResult.content[0].text).toContain('Not connected');
    expect(resourceResult.contents[0].text).toContain('Not connected');
    expect(promptResult.messages[0].content.type).toBe('text');
  });

  it('returns cached definitions as defensive copies', () => {
    const bundler = createBundler();
    const bundlerAny = bundler as unknown as {
      lastPrompts: Array<{ name: string; arguments: Array<{ name: string }> }>;
      lastResources: Array<{ uri: string; name: string }>;
      lastTools: Array<{ name: string; inputSchema: { type: string } }>;
    };
    bundlerAny.lastTools = [{ name: 'k8s', inputSchema: { type: 'object' } }];
    bundlerAny.lastResources = [{ uri: 'kunobi://status', name: 'status' }];
    bundlerAny.lastPrompts = [
      { name: 'setup', arguments: [{ name: 'cluster' }] },
    ];

    const tools = bundler.getToolDefinitions();
    const resources = bundler.getResourceDefinitions();
    const prompts = bundler.getPromptDefinitions();

    const firstTool = tools[0];
    const firstResource = resources[0];
    const firstPrompt = prompts[0];

    if (!firstTool || !firstResource || !firstPrompt) {
      throw new Error('expected cached definitions to be present');
    }

    firstTool.name = 'changed';
    firstResource.uri = 'kunobi://changed';
    firstPrompt.name = 'changed';

    expect(bundler.getToolDefinitions()[0]?.name).toBe('k8s');
    expect(bundler.getResourceDefinitions()[0]?.uri).toBe('kunobi://status');
    expect(bundler.getPromptDefinitions()[0]?.name).toBe('setup');
  });
});

describe('McpBundlerServerAdapter', () => {
  function toolDefinitions(): Tool[] {
    return [
      {
        name: 'k8s',
        description: 'Kubernetes operations',
        inputSchema: {
          type: 'object',
          properties: {
            action: { description: 'Action to run', type: 'string' },
          },
          required: ['action'],
        },
      } as Tool,
    ];
  }

  function resourceDefinitions(): Resource[] {
    return [
      {
        name: 'status',
        uri: 'kunobi://resource/status',
        description: 'Status resource',
      } as Resource,
    ];
  }

  function promptDefinitions(): Prompt[] {
    return [
      {
        name: 'setup',
        description: 'Setup prompt',
        arguments: [{ name: 'cluster', required: false }],
      } as Prompt,
    ];
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers prefixed tools and forwards calls through the bundler', async () => {
    const bundler = createBundler();
    vi.spyOn(bundler, 'listTools').mockResolvedValue(toolDefinitions());
    const callTool = vi.spyOn(bundler, 'callTool').mockResolvedValue({
      content: [{ type: 'text', text: 'forwarded' }],
    });

    const adapter = new McpBundlerServerAdapter(bundler, {
      toolPrefix: 'dev__',
    });
    const server = createServer();

    await adapter.registerTools(server);

    const tool = (server as unknown as ServerInternals)._registeredTools
      .dev__k8s;
    expect(tool).toBeDefined();

    await tool.handler?.({ action: 'list' });
    expect(callTool).toHaveBeenCalledWith('k8s', { action: 'list' });
  });

  it('registers namespaced resources and keeps downstream reads on the original URI', async () => {
    const bundler = createBundler();
    vi.spyOn(bundler, 'listResources').mockResolvedValue(resourceDefinitions());
    const readResource = vi.spyOn(bundler, 'readResource').mockResolvedValue({
      contents: [{ uri: 'kunobi://resource/status', text: 'ok' }],
    });

    const adapter = new McpBundlerServerAdapter(bundler, {
      mapResource: (resource) => ({
        name: `dev__${resource.name}`,
        uri: `kunobi://variant/dev/resource/${encodeURIComponent(resource.uri)}`,
      }),
    });
    let handler: undefined | (() => ReturnType<typeof bundler.readResource>);
    const registerResource = vi.fn(
      (_name, _uri, _meta, nextHandler: typeof handler) => {
        handler = nextHandler;
      },
    );
    const server = {
      registerResource,
    } as unknown as McpServer;

    await adapter.registerResources(server);

    expect(registerResource.mock.calls[0]?.[1]).toBe(
      'kunobi://variant/dev/resource/kunobi%3A%2F%2Fresource%2Fstatus',
    );

    await handler?.();
    expect(readResource).toHaveBeenCalledWith('kunobi://resource/status');
  });

  it('registers prefixed prompts and forwards prompt requests', async () => {
    const bundler = createBundler();
    vi.spyOn(bundler, 'listPrompts').mockResolvedValue(promptDefinitions());
    const getPrompt = vi.spyOn(bundler, 'getPrompt').mockResolvedValue({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: 'prompt' },
        },
      ],
    });

    const adapter = new McpBundlerServerAdapter(bundler, {
      promptPrefix: 'dev__',
    });
    let handler:
      | undefined
      | ((args: unknown) => ReturnType<typeof bundler.getPrompt>);
    const registerPrompt = vi.fn(
      (_name, _meta, nextHandler: typeof handler) => {
        handler = nextHandler;
      },
    );
    const server = {
      registerPrompt,
    } as unknown as McpServer;

    await adapter.registerPrompts(server);

    expect(registerPrompt.mock.calls[0]?.[0]).toBe('dev__setup');

    await handler?.({ cluster: 'dev-cluster' });
    expect(getPrompt).toHaveBeenCalledWith('setup', { cluster: 'dev-cluster' });
  });

  it('unregisters only the entries it previously registered', () => {
    const bundler = createBundler();
    const adapter = new McpBundlerServerAdapter(bundler);
    const adapterAny = adapter as unknown as {
      registeredPromptNames: Set<string>;
      registeredResourceUris: Set<string>;
      registeredToolNames: Set<string>;
    };
    adapterAny.registeredToolNames.add('dev__k8s');
    adapterAny.registeredResourceUris.add(
      'kunobi://variant/dev/resource/status',
    );
    adapterAny.registeredPromptNames.add('dev__setup');

    const removeTool = vi.fn();
    const removeResource = vi.fn();
    const removePrompt = vi.fn();
    const fakeServer = {
      _registeredTools: {
        dev__k8s: { remove: removeTool },
        other: { remove: vi.fn() },
      },
      _registeredResources: {
        'kunobi://variant/dev/resource/status': { remove: removeResource },
        'kunobi://other': { remove: vi.fn() },
      },
      _registeredPrompts: {
        dev__setup: { remove: removePrompt },
        other: { remove: vi.fn() },
      },
    } as unknown as McpServer;

    adapter.unregisterTools(fakeServer);
    adapter.unregisterResources(fakeServer);
    adapter.unregisterPrompts(fakeServer);

    expect(removeTool).toHaveBeenCalledOnce();
    expect(removeResource).toHaveBeenCalledOnce();
    expect(removePrompt).toHaveBeenCalledOnce();
    expect(adapterAny.registeredToolNames.size).toBe(0);
    expect(adapterAny.registeredResourceUris.size).toBe(0);
    expect(adapterAny.registeredPromptNames.size).toBe(0);
  });
});
