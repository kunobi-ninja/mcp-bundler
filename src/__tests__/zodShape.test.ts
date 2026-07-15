import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { zodShapeFromJsonSchema } from '../adapter.js';

/**
 * Regression suite for the bug where the bundler collapsed every proxied-tool
 * parameter to `z.any()`, discarding the JSON-Schema `type`. That made every
 * re-exposed variant tool advertise a typeless schema upstream, so typed args
 * (numbers, booleans, nested objects) round-tripped as the wrong JSON type and
 * were then rejected by the downstream app's strict validator (bogus
 * SCHEMA_INVALID). See kunobi-frontend#2565.
 *
 * The fix must honor the declared `type`. These tests pin that end-to-end via
 * `.safeParse` behavior on the produced zod schema.
 */

/** Build a schema from a single-property object schema for terse assertions. */
function fieldSchema(prop: Record<string, unknown>, required = true) {
  const inputSchema = {
    type: 'object',
    properties: { v: prop },
    required: required ? ['v'] : [],
  } as unknown as Tool['inputSchema'];
  return zodShapeFromJsonSchema(inputSchema);
}

describe('zodShapeFromJsonSchema — type fidelity', () => {
  it('string: accepts a string, rejects a number', () => {
    const s = fieldSchema({ type: 'string' });
    expect(s.safeParse({ v: 'hello' }).success).toBe(true);
    expect(s.safeParse({ v: 42 }).success).toBe(false);
  });

  it('integer: accepts a number, REJECTS a stringified number (the core bug)', () => {
    const s = fieldSchema({ type: 'integer' });
    expect(s.safeParse({ v: 3999 }).success).toBe(true);
    // The whole defect: '3999' used to slip through z.any() and reach the app,
    // which rejected it. A typed schema must not silently accept the string.
    expect(s.safeParse({ v: '3999' }).success).toBe(false);
  });

  it('number: accepts a float, rejects a string', () => {
    const s = fieldSchema({ type: 'number' });
    expect(s.safeParse({ v: 1.5 }).success).toBe(true);
    expect(s.safeParse({ v: 'nope' }).success).toBe(false);
  });

  it('boolean: accepts true/false, rejects the STRING "false"', () => {
    const s = fieldSchema({ type: 'boolean' });
    expect(s.safeParse({ v: false }).success).toBe(true);
    expect(s.safeParse({ v: true }).success).toBe(true);
    // "false" must not be coerced — string→boolean coercion is a footgun
    // (any non-empty string is truthy). It must fail, not become `true`.
    expect(s.safeParse({ v: 'false' }).success).toBe(false);
  });

  it('array of strings: accepts a string[], rejects a number[]', () => {
    const s = fieldSchema({ type: 'array', items: { type: 'string' } });
    expect(s.safeParse({ v: ['a', 'b'] }).success).toBe(true);
    expect(s.safeParse({ v: [1, 2] }).success).toBe(false);
  });

  it('enum: accepts a member, rejects a non-member', () => {
    const s = fieldSchema({ type: 'string', enum: ['llm', 'mcp'] });
    expect(s.safeParse({ v: 'llm' }).success).toBe(true);
    expect(s.safeParse({ v: 'other' }).success).toBe(false);
  });

  it('nested object: recurses and enforces inner types', () => {
    const s = fieldSchema({
      type: 'object',
      properties: { port: { type: 'integer' } },
      required: ['port'],
    });
    expect(s.safeParse({ v: { port: 8080 } }).success).toBe(true);
    expect(s.safeParse({ v: { port: '8080' } }).success).toBe(false);
  });

  it('untyped property: falls back to accepting anything (unchanged behavior)', () => {
    const s = fieldSchema({ description: 'freeform, no type' });
    expect(s.safeParse({ v: 3999 }).success).toBe(true);
    expect(s.safeParse({ v: 'x' }).success).toBe(true);
    expect(s.safeParse({ v: { any: 'thing' } }).success).toBe(true);
  });

  it('required vs optional is preserved', () => {
    const req = fieldSchema({ type: 'string' }, true);
    expect(req.safeParse({}).success).toBe(false);
    const opt = fieldSchema({ type: 'string' }, false);
    expect(opt.safeParse({}).success).toBe(true);
  });

  it('no properties: passthrough object (unchanged behavior)', () => {
    const s = zodShapeFromJsonSchema({
      type: 'object',
    } as unknown as Tool['inputSchema']);
    expect(s.safeParse({ anything: 1, else: 'ok' }).success).toBe(true);
  });

  it('unknown keys pass through (proxy must not drop caller-supplied extras)', () => {
    const s = fieldSchema({ type: 'string' });
    const r = s.safeParse({ v: 'x', extra: 7 });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as Record<string, unknown>).extra).toBe(7);
  });

  it('a mixed real-world tool schema round-trips every typed value', () => {
    // Mirrors an agentgateway proxy_add-style schema: the exact shape that
    // triggered the original SCHEMA_INVALID.
    const s = zodShapeFromJsonSchema({
      type: 'object',
      properties: {
        name: { type: 'string' },
        port: { type: 'integer' },
        auto_start: { type: 'boolean' },
        provider_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'port'],
    } as unknown as Tool['inputSchema']);

    expect(
      s.safeParse({
        name: 'gw',
        port: 8080,
        auto_start: true,
        provider_ids: ['a', 'b'],
      }).success,
    ).toBe(true);

    // Every scalar sent as a string — the failure mode a typeless schema caused.
    expect(s.safeParse({ name: 'gw', port: '8080' }).success).toBe(false);
    expect(
      s.safeParse({ name: 'gw', port: 8080, auto_start: 'false' }).success,
    ).toBe(false);
  });
});
