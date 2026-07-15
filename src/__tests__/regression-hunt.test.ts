import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { zodShapeFromJsonSchema } from '../adapter.js';

/**
 * REGRESSION HUNT for the typed-schema change (adapter.ts @ 1f6c69b).
 *
 * Contract under test: the new typed mapping must NEVER reject an input that
 * the old `z.any()` mapping accepted AND that the downstream server would
 * itself accept. Every test here asserts the OLD (z.any) acceptance for such
 * inputs — so a FAILING test is a candidate regression: old-accept → new-reject.
 *
 * Passing tests prove no regression for that shape. Shapes already pinned by
 * zodShape.test.ts (anyOf:[{$ref},{null}], bare $ref, plain type-arrays) are
 * not repeated here.
 */

/** Single-property object schema helper (same idiom as zodShape.test.ts). */
function fieldSchema(prop: unknown, required = false) {
  const inputSchema = {
    type: 'object',
    properties: { v: prop },
    required: required ? ['v'] : [],
  } as unknown as Tool['inputSchema'];
  return zodShapeFromJsonSchema(inputSchema);
}

describe('HUNT: explicit null on optional but non-nullable fields', () => {
  // JSON-emitting clients routinely send `"field": null` for "not set" instead
  // of omitting the key. Old z.any().optional() accepted that; a strict
  // schemars downstream would reject null for a non-Option field anyway, so a
  // new-reject here is arguably "stricter on already-invalid input" — but it
  // moves the rejection from the downstream (real error) to the proxy (bogus
  // upstream-schema error). Probing to make the behavior change visible.

  // ADJUDICATED (codex + fable, both families agree): rejecting `null` on an
  // optional but NON-nullable field is CORRECT, not a regression. `null` is not
  // a valid value for `{type:"string"}` per JSON Schema, and a strict serde
  // downstream rejects `null` for a non-`Option` field regardless — so no valid
  // call is lost. The only change is the error's origin (proxy vs downstream).
  // "Optional" (absent from `required`) means may-be-omitted, NOT may-be-null.
  it('optional non-nullable string enum {type:string,enum:[a,b]}: rejects null, still allows OMITTED', () => {
    const s = fieldSchema({ type: 'string', enum: ['llm', 'mcp'] }, false);
    expect(s.safeParse({ v: 'llm' }).success).toBe(true); // member ok
    expect(s.safeParse({}).success).toBe(true); // omitted (optional) ok
    expect(s.safeParse({ v: null }).success).toBe(false); // null is not a member
  });

  it('optional plain {type:"string"}: rejects null, still allows OMITTED', () => {
    const s = fieldSchema({ type: 'string' }, false);
    expect(s.safeParse({}).success).toBe(true); // omitted (optional) ok
    expect(s.safeParse({ v: null }).success).toBe(false); // null is not a string
  });
});

describe('HUNT: nullable encodings the mapper does not model', () => {
  it('OpenAPI-style {type:"string",nullable:true} (older schemars) — value AND null accepted downstream', () => {
    const s = fieldSchema({ type: 'string', nullable: true }, false);
    expect(s.safeParse({ v: 'x' }).success).toBe(true);
    // Downstream declared nullable — it ACCEPTS null. Old z.any() forwarded it.
    expect(s.safeParse({ v: null }).success).toBe(true); // old-accept probe
  });

  it('{type:["string","null"],enum:["a","b"]} — enum branch must not shadow the null branch', () => {
    // Some generators emit a nullable enum as a type-array plus an enum list
    // that omits null. `type` says null is legal; downstream accepts it.
    const s = fieldSchema({ type: ['string', 'null'], enum: ['a', 'b'] }, false);
    expect(s.safeParse({ v: 'a' }).success).toBe(true);
    expect(s.safeParse({ v: null }).success).toBe(true); // old-accept probe
  });
});

describe('HUNT: composite keywords without a top-level type stay permissive', () => {
  it('allOf: [{type:"string"}] — permissive (no top-level type)', () => {
    const s = fieldSchema({ allOf: [{ type: 'string' }] }, true);
    expect(s.safeParse({ v: 'x' }).success).toBe(true);
    expect(s.safeParse({ v: 42 }).success).toBe(true); // old z.any() accepted
  });

  it('oneOf: [{type:"string"},{type:"integer"}] — permissive', () => {
    const s = fieldSchema(
      { oneOf: [{ type: 'string' }, { type: 'integer' }] },
      true,
    );
    expect(s.safeParse({ v: 'x' }).success).toBe(true);
    expect(s.safeParse({ v: 7 }).success).toBe(true);
    expect(s.safeParse({ v: { even: 'this' } }).success).toBe(true);
  });

  it('bare const (no type): {const:"fixed"} — permissive', () => {
    const s = fieldSchema({ const: 'fixed' }, true);
    expect(s.safeParse({ v: 'fixed' }).success).toBe(true);
    expect(s.safeParse({ v: 'anything-else' }).success).toBe(true);
  });

  it('typed const: {type:"string",const:"fixed"} — const value itself still accepted', () => {
    const s = fieldSchema({ type: 'string', const: 'fixed' }, true);
    expect(s.safeParse({ v: 'fixed' }).success).toBe(true);
  });
});

describe('HUNT: tuple-style items (items as an ARRAY of schemas)', () => {
  const tuple = { type: 'array', items: [{ type: 'string' }, { type: 'number' }] };

  it('a correct tuple value is accepted', () => {
    const s = fieldSchema(tuple, true);
    expect(s.safeParse({ v: ['a', 1] }).success).toBe(true);
  });

  it('a tuple value the old z.any() accepted (wrong per-position types) is still accepted', () => {
    // The mapper cannot model positional schemas; it must stay permissive on
    // element types rather than newly reject.
    const s = fieldSchema(tuple, true);
    expect(s.safeParse({ v: [1, 'a', true] }).success).toBe(true);
  });
});

describe('HUNT: non-string enums', () => {
  it('bare numeric enum {enum:[1,2,3]} — members accepted', () => {
    const s = fieldSchema({ enum: [1, 2, 3] }, true);
    expect(s.safeParse({ v: 1 }).success).toBe(true);
    expect(s.safeParse({ v: 3 }).success).toBe(true);
  });

  it('typed integer enum {type:"integer",enum:[0,1]} — members accepted', () => {
    const s = fieldSchema({ type: 'integer', enum: [0, 1] }, true);
    expect(s.safeParse({ v: 0 }).success).toBe(true);
    expect(s.safeParse({ v: 1 }).success).toBe(true);
  });

  it('enum containing null {type:["string","null"],enum:["a",null]} — null member accepted', () => {
    const s = fieldSchema({ type: ['string', 'null'], enum: ['a', null] }, false);
    expect(s.safeParse({ v: 'a' }).success).toBe(true);
    expect(s.safeParse({ v: null }).success).toBe(true);
  });

  it('enum of OBJECT values — a deep-equal member was accepted by z.any() and by downstream', () => {
    // Valid JSON Schema: enum members may be any JSON value. z.literal compares
    // by identity/includes, so a structurally-equal object can never match.
    const s = fieldSchema({ enum: [{ level: 'high' }, { level: 'low' }] }, true);
    expect(s.safeParse({ v: { level: 'high' } }).success).toBe(true); // old-accept probe
  });

  it('enum of ARRAY values — a deep-equal member was accepted by z.any() and by downstream', () => {
    const s = fieldSchema({ enum: [['a', 'b']] }, true);
    expect(s.safeParse({ v: ['a', 'b'] }).success).toBe(true); // old-accept probe
  });
});

describe('HUNT: uint64 beyond Number.MAX_SAFE_INTEGER (real production shape: request_timeout_secs)', () => {
  // Production sends {"type":["integer","null"],"format":"uint64"} (verbatim
  // schemars output). A u64 downstream happily accepts values > 2^53. zod 4's
  // .int() rejects unsafe integers, so the typed mapping may newly reject what
  // z.any() forwarded fine.

  it('safe integer sanity: MAX_SAFE_INTEGER accepted', () => {
    const s = fieldSchema({ type: 'integer', format: 'uint64' }, true);
    expect(s.safeParse({ v: Number.MAX_SAFE_INTEGER }).success).toBe(true);
  });

  it('2^53 (first unsafe integer) — old z.any() accepted, downstream u64 accepts', () => {
    const s = fieldSchema({ type: 'integer', format: 'uint64' }, true);
    expect(s.safeParse({ v: 2 ** 53 }).success).toBe(true); // old-accept probe
  });

  it('u64-scale value (~1.8e19) on the verbatim request_timeout_secs shape {type:["integer","null"],format:"uint64"}', () => {
    const s = fieldSchema({ type: ['integer', 'null'], format: 'uint64' }, false);
    expect(s.safeParse({ v: null }).success).toBe(true); // clearing still works
    expect(s.safeParse({ v: 2 ** 63 }).success).toBe(true); // old-accept probe
  });
});

describe('HUNT: deeply nested Option<Vec<Option<T>>> shapes', () => {
  it('{type:["array","null"],items:{type:["string","null"]}} — value, inner null, outer null all accepted', () => {
    const s = fieldSchema(
      { type: ['array', 'null'], items: { type: ['string', 'null'] } },
      false,
    );
    expect(s.safeParse({ v: ['a', null, 'b'] }).success).toBe(true);
    expect(s.safeParse({ v: [] }).success).toBe(true);
    expect(s.safeParse({ v: null }).success).toBe(true);
  });

  it('nested object with Option fields two levels down', () => {
    const s = fieldSchema(
      {
        type: ['object', 'null'],
        properties: {
          limits: {
            type: 'object',
            properties: {
              max: { type: ['integer', 'null'] },
              tags: { type: ['array', 'null'], items: { type: 'string' } },
            },
            required: [],
          },
        },
        required: [],
      },
      false,
    );
    expect(s.safeParse({ v: null }).success).toBe(true);
    expect(
      s.safeParse({ v: { limits: { max: null, tags: null } } }).success,
    ).toBe(true);
    expect(
      s.safeParse({ v: { limits: { max: 5, tags: ['x'] } } }).success,
    ).toBe(true);
  });
});

describe('HUNT: additionalProperties:false must not newly strip/reject extras', () => {
  it('extras still accepted and preserved (proxy stays passthrough)', () => {
    const s = zodShapeFromJsonSchema({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    } as unknown as Tool['inputSchema']);
    const r = s.safeParse({ name: 'gw', extra: 7 });
    expect(r.success).toBe(true);
    if (r.success) expect((r.data as Record<string, unknown>).extra).toBe(7);
  });

  it('nested object with additionalProperties:false — extras inside also survive', () => {
    const s = fieldSchema(
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        required: [],
        additionalProperties: false,
      },
      true,
    );
    const r = s.safeParse({ v: { a: 'x', b: 1 } });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as { v: Record<string, unknown> }).v.b).toBe(1);
    }
  });
});

describe('HUNT: boolean and empty property schemas', () => {
  it('property schema literally true — accepts anything', () => {
    const s = fieldSchema(true, true);
    expect(s.safeParse({ v: 'x' }).success).toBe(true);
    expect(s.safeParse({ v: { deep: [1] } }).success).toBe(true);
    expect(s.safeParse({ v: null }).success).toBe(true);
  });

  it('property schema {} — accepts anything', () => {
    const s = fieldSchema({}, true);
    expect(s.safeParse({ v: 42 }).success).toBe(true);
    expect(s.safeParse({ v: null }).success).toBe(true);
  });

  it('property schema literally false — old z.any() accepted anything; must not newly reject', () => {
    // Spec-wise `false` means "never", but the proxy contract is "never reject
    // what the old mapping forwarded"; downstream enforces the real schema.
    const s = fieldSchema(false, true);
    expect(s.safeParse({ v: 'anything' }).success).toBe(true);
  });
});
