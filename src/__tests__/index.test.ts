import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatError, McpBundler } from '../index.js';

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

describe('McpBundler (http)', () => {
  let bundler: McpBundler;

  beforeEach(() => {
    bundler = new McpBundler({
      name: 'test',
      transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      reconnect: { enabled: false },
      logger: () => {},
    });
  });

  afterEach(async () => {
    await bundler.close();
  });

  describe('initial state', () => {
    it('starts in idle state', () => {
      expect(bundler.getState()).toBe('idle');
    });

    it('starts with no tools', () => {
      expect(bundler.getTools()).toEqual([]);
    });

    it('exposes name', () => {
      expect(bundler.name).toBe('test');
    });
  });

  describe('connect', () => {
    it('transitions to disconnected on connection failure', async () => {
      await bundler.connect();
      expect(bundler.getState()).toBe('disconnected');
    });

    it('does not connect when already closed', async () => {
      await bundler.close();
      await bundler.connect();
      expect(bundler.getState()).toBe('idle');
    });

    it('prevents duplicate connect calls', async () => {
      const p1 = bundler.connect();
      const p2 = bundler.connect();
      await Promise.all([p1, p2]);
      expect(bundler.getState()).toBe('disconnected');
    });
  });

  describe('listTools', () => {
    it('returns empty array when not connected', async () => {
      const tools = await bundler.listTools();
      expect(tools).toEqual([]);
    });
  });

  describe('close', () => {
    it('transitions to idle', async () => {
      await bundler.connect();
      expect(bundler.getState()).toBe('disconnected');
      await bundler.close();
      expect(bundler.getState()).toBe('idle');
    });

    it('is idempotent', async () => {
      await bundler.close();
      await bundler.close();
      expect(bundler.getState()).toBe('idle');
    });
  });

  describe('reconnection', () => {
    it('stays disconnected after failed connect with reconnect enabled', async () => {
      const reconnectBundler = new McpBundler({
        name: 'reconnect-test',
        transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
        reconnect: { enabled: true, intervalMs: 100, maxRetries: 2 },
        logger: () => {},
      });

      await reconnectBundler.connect();
      // After a failed connect with reconnect enabled, state should be disconnected
      // and a reconnect timer should be scheduled
      expect(reconnectBundler.getState()).toBe('disconnected');

      await reconnectBundler.close();
    });

    it('does not schedule reconnect when disabled', async () => {
      await bundler.connect();
      expect(bundler.getState()).toBe('disconnected');

      // Wait a bit — no reconnect should happen since it's disabled
      await new Promise((r) => setTimeout(r, 50));
      expect(bundler.getState()).toBe('disconnected');
    });

    it('close cancels pending reconnect', async () => {
      const reconnectBundler = new McpBundler({
        name: 'reconnect-test',
        transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
        reconnect: { enabled: true, intervalMs: 50, maxRetries: 5 },
        logger: () => {},
      });

      await reconnectBundler.connect();
      expect(reconnectBundler.getState()).toBe('disconnected');

      // Close should cancel any pending reconnect timer
      await reconnectBundler.close();
      expect(reconnectBundler.getState()).toBe('idle');

      // Wait past the reconnect interval — state should remain idle
      await new Promise((r) => setTimeout(r, 100));
      expect(reconnectBundler.getState()).toBe('idle');
    });
  });

  describe('events', () => {
    it('does not emit connected on failure', async () => {
      const handler = vi.fn();
      bundler.on('connected', handler);
      await bundler.connect();
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('unregisterTools', () => {
    it('handles server without _registeredTools gracefully', () => {
      const fakeServer = {} as Parameters<typeof bundler.unregisterTools>[0];
      expect(() => bundler.unregisterTools(fakeServer)).not.toThrow();
    });

    it('calls remove() on registered tools', () => {
      const removeFn = vi.fn();
      const tools: Record<string, { remove: () => void }> = {
        tool_a: { remove: removeFn },
        tool_b: { remove: vi.fn() },
      };

      const bundlerAny = bundler as unknown as {
        registeredToolNames: Set<string>;
      };
      bundlerAny.registeredToolNames.add('tool_a');

      const fakeServer = { _registeredTools: tools } as unknown as Parameters<
        typeof bundler.unregisterTools
      >[0];
      bundler.unregisterTools(fakeServer);

      expect(removeFn).toHaveBeenCalledOnce();
      expect(tools.tool_b.remove).not.toHaveBeenCalled();
    });
  });

  describe('defaults', () => {
    it('uses default reconnect options', () => {
      const defaultBundler = new McpBundler({
        name: 'defaults',
        transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      });
      expect(defaultBundler.getState()).toBe('idle');
    });

    it('uses default logger without throwing', async () => {
      const defaultBundler = new McpBundler({
        name: 'defaults',
        transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
        reconnect: { enabled: false },
      });
      await defaultBundler.connect();
      expect(defaultBundler.getState()).toBe('disconnected');
      await defaultBundler.close();
    });
  });
});

describe('McpBundler (stdio)', () => {
  it('accepts stdio transport config', () => {
    const bundler = new McpBundler({
      name: 'stdio-test',
      transport: {
        type: 'stdio',
        command: 'echo',
        args: ['hello'],
        env: { FOO: 'bar' },
      },
      reconnect: { enabled: false },
      logger: () => {},
    });
    expect(bundler.getState()).toBe('idle');
    expect(bundler.name).toBe('stdio-test');
  });

  it('does not schedule reconnect for stdio transport', async () => {
    const logMessages: string[] = [];
    const bundler = new McpBundler({
      name: 'stdio-no-reconnect',
      transport: { type: 'stdio', command: 'false' },
      reconnect: { enabled: true, intervalMs: 10, maxRetries: 5 },
      logger: (_level, msg) => logMessages.push(msg),
    });

    await bundler.connect();
    expect(bundler.getState()).toBe('disconnected');

    // Wait past the reconnect interval — no reconnect should be scheduled for stdio
    await new Promise((r) => setTimeout(r, 50));
    expect(bundler.getState()).toBe('disconnected');

    // Verify no "Reconnecting" log was emitted
    expect(logMessages.some((m) => m.includes('Reconnecting'))).toBe(false);

    await bundler.close();
  });
});

describe('registerTools with prefix', () => {
  it('stores prefixed names in registeredToolNames', () => {
    const bundler = new McpBundler({
      name: 'prefix-test',
      transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      reconnect: { enabled: false },
      logger: () => {},
    });

    // Simulate what registerTools does with prefixed names
    const bundlerAny = bundler as unknown as {
      registeredToolNames: Set<string>;
    };

    // Manually add prefixed names as registerTools would
    bundlerAny.registeredToolNames.add('ga_get_report');
    bundlerAny.registeredToolNames.add('ga_list_properties');

    // Verify unregisterTools uses prefixed names
    const removeFn1 = vi.fn();
    const removeFn2 = vi.fn();
    const fakeServer = {
      _registeredTools: {
        ga_get_report: { remove: removeFn1 },
        ga_list_properties: { remove: removeFn2 },
        other_tool: { remove: vi.fn() },
      },
    } as unknown as Parameters<typeof bundler.unregisterTools>[0];

    bundler.unregisterTools(fakeServer);
    expect(removeFn1).toHaveBeenCalledOnce();
    expect(removeFn2).toHaveBeenCalledOnce();
  });
});

describe('registerResources / registerPrompts', () => {
  it('registerResources returns early when not connected', async () => {
    const bundler = new McpBundler({
      name: 'resources-test',
      transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      reconnect: { enabled: false },
      logger: () => {},
    });

    // Should not throw — just returns early since client is null
    await expect(
      bundler.registerResources(
        {} as Parameters<typeof bundler.registerResources>[0],
      ),
    ).resolves.toBeUndefined();

    await bundler.close();
  });

  it('registerPrompts returns early when not connected', async () => {
    const bundler = new McpBundler({
      name: 'prompts-test',
      transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      reconnect: { enabled: false },
      logger: () => {},
    });

    // Should not throw — just returns early since client is null
    await expect(
      bundler.registerPrompts(
        {} as Parameters<typeof bundler.registerPrompts>[0],
      ),
    ).resolves.toBeUndefined();

    await bundler.close();
  });
});

describe('unregisterResources', () => {
  it('handles server without _registeredResources gracefully', () => {
    const bundler = new McpBundler({
      name: 'test',
      transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      reconnect: { enabled: false },
      logger: () => {},
    });
    const fakeServer = {} as Parameters<typeof bundler.unregisterResources>[0];
    expect(() => bundler.unregisterResources(fakeServer)).not.toThrow();
  });

  it('calls remove() on registered resources', () => {
    const bundler = new McpBundler({
      name: 'test',
      transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      reconnect: { enabled: false },
      logger: () => {},
    });

    const removeFn = vi.fn();
    const resources: Record<string, { remove: () => void }> = {
      'test://a': { remove: removeFn },
      'test://b': { remove: vi.fn() },
    };

    const bundlerAny = bundler as unknown as {
      registeredResourceUris: Set<string>;
    };
    bundlerAny.registeredResourceUris.add('test://a');

    const fakeServer = {
      _registeredResources: resources,
    } as unknown as Parameters<typeof bundler.unregisterResources>[0];
    bundler.unregisterResources(fakeServer);

    expect(removeFn).toHaveBeenCalledOnce();
    expect(resources['test://b'].remove).not.toHaveBeenCalled();
  });

  it('clears registeredResourceUris after unregister', () => {
    const bundler = new McpBundler({
      name: 'test',
      transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      reconnect: { enabled: false },
      logger: () => {},
    });

    const bundlerAny = bundler as unknown as {
      registeredResourceUris: Set<string>;
    };
    bundlerAny.registeredResourceUris.add('test://a');

    const fakeServer = {
      _registeredResources: { 'test://a': { remove: vi.fn() } },
    } as unknown as Parameters<typeof bundler.unregisterResources>[0];
    bundler.unregisterResources(fakeServer);

    expect(bundlerAny.registeredResourceUris.size).toBe(0);
  });
});

describe('unregisterPrompts', () => {
  it('handles server without _registeredPrompts gracefully', () => {
    const bundler = new McpBundler({
      name: 'test',
      transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      reconnect: { enabled: false },
      logger: () => {},
    });
    const fakeServer = {} as Parameters<typeof bundler.unregisterPrompts>[0];
    expect(() => bundler.unregisterPrompts(fakeServer)).not.toThrow();
  });

  it('calls remove() on registered prompts', () => {
    const bundler = new McpBundler({
      name: 'test',
      transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      reconnect: { enabled: false },
      logger: () => {},
    });

    const removeFn = vi.fn();
    const prompts: Record<string, { remove: () => void }> = {
      dev__setup: { remove: removeFn },
      dev__other: { remove: vi.fn() },
    };

    const bundlerAny = bundler as unknown as {
      registeredPromptNames: Set<string>;
    };
    bundlerAny.registeredPromptNames.add('dev__setup');

    const fakeServer = {
      _registeredPrompts: prompts,
    } as unknown as Parameters<typeof bundler.unregisterPrompts>[0];
    bundler.unregisterPrompts(fakeServer);

    expect(removeFn).toHaveBeenCalledOnce();
    expect(prompts.dev__other.remove).not.toHaveBeenCalled();
  });
});

describe('getResources / getPrompts', () => {
  it('starts with empty resources and prompts', () => {
    const bundler = new McpBundler({
      name: 'test',
      transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      reconnect: { enabled: false },
      logger: () => {},
    });
    expect(bundler.getResources()).toEqual([]);
    expect(bundler.getPrompts()).toEqual([]);
  });
});

describe('listResources / listPrompts', () => {
  it('listResources returns empty when not connected', async () => {
    const bundler = new McpBundler({
      name: 'test',
      transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      reconnect: { enabled: false },
      logger: () => {},
    });
    expect(await bundler.listResources()).toEqual([]);
    await bundler.close();
  });

  it('listPrompts returns empty when not connected', async () => {
    const bundler = new McpBundler({
      name: 'test',
      transport: { type: 'http', url: 'http://127.0.0.1:9999/mcp' },
      reconnect: { enabled: false },
      logger: () => {},
    });
    expect(await bundler.listPrompts()).toEqual([]);
    await bundler.close();
  });
});
