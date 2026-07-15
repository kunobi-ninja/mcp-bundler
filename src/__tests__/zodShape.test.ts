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

  it('string enum: typed as string (accepts members AND non-members), rejects wrong type', () => {
    // Enums are typed by their BASE type, not enforced by membership: a
    // downstream may accept values outside the advertised list via serde
    // `#[serde(alias)]`, so rejecting a non-member would be a regression. We
    // still reject the wrong TYPE (a stringified/other type).
    const s = fieldSchema({ type: 'string', enum: ['llm', 'mcp'] });
    expect(s.safeParse({ v: 'llm' }).success).toBe(true);
    expect(s.safeParse({ v: 'legacy' }).success).toBe(true); // serde alias — must NOT reject
    expect(s.safeParse({ v: 42 }).success).toBe(false); // wrong type still rejected
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

  // ── Regression guard: REAL schemars shapes ────────────────────────────────
  // schemars encodes `Option<T>` as a type-array containing "null", and
  // `Option<Enum>` as `anyOf: [{$ref}, {type:null}]`. These dominate the real
  // tool schemas (every optional/clearable field). A naive `type[0]` mapping
  // would reject `null` and break field-clearing — the exact path that sends
  // `null` to clear `rate_limit_id` / `mcpSessionIdleTtlSecs`. These tests pin
  // that `null` still passes while the wrong scalar type is still rejected.

  it('Option<integer> — {type:[integer,null]}: accepts a number AND null, rejects a string', () => {
    const s = fieldSchema(
      { type: ['integer', 'null'], format: 'uint16' },
      false,
    );
    expect(s.safeParse({ v: 8080 }).success).toBe(true);
    expect(s.safeParse({ v: null }).success).toBe(true); // clearing must work
    expect(s.safeParse({ v: '8080' }).success).toBe(false);
  });

  it('Option<string> — {type:[string,null]}: accepts a string AND null, rejects a number', () => {
    const s = fieldSchema({ type: ['string', 'null'] }, false);
    expect(s.safeParse({ v: 'uuid' }).success).toBe(true);
    expect(s.safeParse({ v: null }).success).toBe(true);
    expect(s.safeParse({ v: 5 }).success).toBe(false);
  });

  it('Option<boolean> — {type:[boolean,null]}: accepts a boolean AND null, rejects "true"', () => {
    const s = fieldSchema({ type: ['boolean', 'null'] }, false);
    expect(s.safeParse({ v: true }).success).toBe(true);
    expect(s.safeParse({ v: null }).success).toBe(true);
    expect(s.safeParse({ v: 'true' }).success).toBe(false);
  });

  it('Option<array> — {type:[array,null], items:string}: accepts string[] AND null, rejects number[]', () => {
    const s = fieldSchema(
      { type: ['array', 'null'], items: { type: 'string' } },
      false,
    );
    expect(s.safeParse({ v: ['a'] }).success).toBe(true);
    expect(s.safeParse({ v: null }).success).toBe(true);
    expect(s.safeParse({ v: [1] }).success).toBe(false);
  });

  it('Option<Enum> — anyOf:[{$ref},{null}]: stays permissive (accepts the value AND null, no false reject)', () => {
    // $ref is unresolved here (defs live at the schema root); the mapper must
    // NOT reject a plausible enum value or null. Permissive is correct — the
    // downstream app validates the enum strictly.
    const s = fieldSchema(
      { anyOf: [{ $ref: '#/$defs/ProxyModeRec' }, { type: 'null' }] },
      false,
    );
    expect(s.safeParse({ v: 'llm' }).success).toBe(true);
    expect(s.safeParse({ v: null }).success).toBe(true);
  });

  it('bare $ref: permissive (unresolved refs must not reject anything)', () => {
    const s = fieldSchema({ $ref: '#/$defs/RateLimitKindRec' }, true);
    expect(s.safeParse({ v: 'requests' }).success).toBe(true);
    expect(s.safeParse({ v: { anything: 1 } }).success).toBe(true);
  });

  it('a real proxy_update-shaped schema clears optionals with null AND rejects stringified scalars', () => {
    // Verbatim-shaped from the live schemars output for agentgateway__proxy_update.
    const s = zodShapeFromJsonSchema({
      type: 'object',
      properties: {
        port: { type: ['integer', 'null'], format: 'uint16' },
        rate_limit_id: { type: ['string', 'null'] },
        mcp_session_idle_ttl_secs: { type: ['integer', 'null'] },
        mcp_stateful: { type: ['boolean', 'null'] },
        provider_ids: { type: ['array', 'null'], items: { type: 'string' } },
        mode: { anyOf: [{ $ref: '#/$defs/ProxyModeRec' }, { type: 'null' }] },
      },
      required: [],
    } as unknown as Tool['inputSchema']);

    // Clearing every optional with null — must pass (was the regression).
    expect(
      s.safeParse({
        rate_limit_id: null,
        mcp_session_idle_ttl_secs: null,
        provider_ids: null,
      }).success,
    ).toBe(true);
    // Real typed edit — must pass.
    expect(s.safeParse({ port: 9090, provider_ids: ['a'] }).success).toBe(true);
    // Stringified scalar — must still fail (the original bug).
    expect(s.safeParse({ port: '9090' }).success).toBe(false);
    expect(s.safeParse({ mcp_stateful: 'false' }).success).toBe(false);
  });

  // ── $ref / anyOf resolution against root $defs ────────────────────────────
  // schemars emits enum fields as `{$ref:"#/$defs/Name"}` or, when optional,
  // `{anyOf:[{$ref:"#/$defs/Name"},{type:"null"}]}`, with the enum living under
  // the schema root's `$defs`. Resolving them types `mode`, `mcp_failure_mode`,
  // `limit_kind`, etc. Resolution only kicks in when `$defs` is actually present
  // at the root — a bare $ref with no defs stays permissive (no regression).

  it('resolves a bare $ref to its $defs enum as a TYPE (string), not membership', () => {
    const s = zodShapeFromJsonSchema({
      type: 'object',
      $defs: { Mode: { type: 'string', enum: ['llm', 'mcp'] } },
      properties: { mode: { $ref: '#/$defs/Mode' } },
      required: ['mode'],
    } as unknown as Tool['inputSchema']);
    expect(s.safeParse({ mode: 'llm' }).success).toBe(true);
    // A resolved enum is typed as string, NOT enforced by membership — a serde
    // alias the downstream accepts must not be rejected (cross-family finding).
    expect(s.safeParse({ mode: 'legacy' }).success).toBe(true);
    expect(s.safeParse({ mode: 123 }).success).toBe(false); // wrong type rejected
  });

  it('resolves anyOf:[{$ref},{null}] to string|null (member ok, null ok, wrong type rejected)', () => {
    const s = zodShapeFromJsonSchema({
      type: 'object',
      $defs: { Mode: { type: 'string', enum: ['llm', 'mcp'] } },
      properties: {
        mode: { anyOf: [{ $ref: '#/$defs/Mode' }, { type: 'null' }] },
      },
      required: [],
    } as unknown as Tool['inputSchema']);
    expect(s.safeParse({ mode: 'llm' }).success).toBe(true);
    expect(s.safeParse({ mode: 'legacy' }).success).toBe(true); // alias-safe
    expect(s.safeParse({ mode: null }).success).toBe(true); // nullable
    expect(s.safeParse({}).success).toBe(true); // optional
    expect(s.safeParse({ mode: 123 }).success).toBe(false); // wrong type
  });

  // ── Cross-family review findings (codex): robustness + alias safety ─────────
  it('serde alias: a resolved enum accepts a value outside its member list', () => {
    // #[serde(alias="legacy")] on a Rust enum → schemars omits the alias, but
    // serde accepts it. Enforcing membership would reject a downstream-valid
    // value. (The whole reason enums are typed, not membership-checked.)
    const s = zodShapeFromJsonSchema({
      type: 'object',
      $defs: { Mode: { type: 'string', enum: ['llm', 'mcp'] } },
      properties: { mode: { $ref: '#/$defs/Mode' } },
      required: ['mode'],
    } as unknown as Tool['inputSchema']);
    expect(s.safeParse({ mode: 'legacy' }).success).toBe(true);
  });

  it('a DEEP $ref chain terminates without a stack overflow', () => {
    const $defs: Record<string, unknown> = {};
    for (let i = 0; i < 5000; i++) {
      $defs[`D${i}`] = {
        type: 'object',
        properties: { next: { $ref: `#/$defs/D${i + 1}` } },
      };
    }
    $defs.D5000 = { $ref: '#/$defs/D0' };
    const s = zodShapeFromJsonSchema({
      type: 'object',
      $defs,
      properties: { root: { $ref: '#/$defs/D0' } },
      required: [],
    } as unknown as Tool['inputSchema']);
    // Must not throw RangeError; the depth bound falls back to permissive.
    expect(s.safeParse({ root: { next: {} } }).success).toBe(true);
  });

  it('a MALFORMED $defs node (required:1) does not crash registration', () => {
    const build = () =>
      zodShapeFromJsonSchema({
        type: 'object',
        $defs: {
          X: {
            type: 'object',
            properties: { a: { type: 'string' } },
            required: 1,
          },
        },
        properties: { v: { $ref: '#/$defs/X' } },
        required: ['v'],
      } as unknown as Tool['inputSchema']);
    expect(build).not.toThrow();
    expect(build().safeParse({ v: { a: 'ok' } }).success).toBe(true);
  });

  it('supports `definitions` (draft-07) as well as `$defs`', () => {
    const s = zodShapeFromJsonSchema({
      type: 'object',
      definitions: { Kind: { type: 'string', enum: ['requests', 'tokens'] } },
      properties: { kind: { $ref: '#/definitions/Kind' } },
      required: ['kind'],
    } as unknown as Tool['inputSchema']);
    expect(s.safeParse({ kind: 'tokens' }).success).toBe(true);
    expect(s.safeParse({ kind: 'nope' }).success).toBe(true); // typed, not membership-enforced
    expect(s.safeParse({ kind: 42 }).success).toBe(false); // wrong type rejected
  });

  it('an UNRESOLVABLE $ref stays permissive (no regression)', () => {
    const s = zodShapeFromJsonSchema({
      type: 'object',
      $defs: {},
      properties: { x: { $ref: '#/$defs/Missing' } },
      required: [],
    } as unknown as Tool['inputSchema']);
    expect(s.safeParse({ x: 'anything' }).success).toBe(true);
    expect(s.safeParse({ x: 123 }).success).toBe(true);
  });

  it('a CIRCULAR $ref terminates and stays permissive (no infinite loop)', () => {
    const s = zodShapeFromJsonSchema({
      type: 'object',
      $defs: {
        Node: {
          type: 'object',
          properties: { next: { $ref: '#/$defs/Node' } },
        },
      },
      properties: { root: { $ref: '#/$defs/Node' } },
      required: [],
    } as unknown as Tool['inputSchema']);
    expect(s.safeParse({ root: { next: {} } }).success).toBe(true);
  });

  it('oneOf maps to a union of its members', () => {
    const s = fieldSchema({
      oneOf: [{ type: 'string' }, { type: 'integer' }],
    });
    expect(s.safeParse({ v: 'x' }).success).toBe(true);
    expect(s.safeParse({ v: 7 }).success).toBe(true);
    expect(s.safeParse({ v: true }).success).toBe(false);
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
