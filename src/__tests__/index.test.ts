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

describe('McpBundler', () => {
  let bundler: McpBundler;

  beforeEach(() => {
    bundler = new McpBundler({
      name: 'test',
      url: 'http://127.0.0.1:9999/mcp',
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
        url: 'http://127.0.0.1:9999/mcp',
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
        url: 'http://127.0.0.1:9999/mcp',
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
        url: 'http://127.0.0.1:9999/mcp',
      });
      expect(defaultBundler.getState()).toBe('idle');
    });

    it('uses default logger without throwing', async () => {
      const defaultBundler = new McpBundler({
        name: 'defaults',
        url: 'http://127.0.0.1:9999/mcp',
        reconnect: { enabled: false },
      });
      await defaultBundler.connect();
      expect(defaultBundler.getState()).toBe('disconnected');
      await defaultBundler.close();
    });
  });
});
