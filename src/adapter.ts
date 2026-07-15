import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  Prompt,
  Resource,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { McpBundler } from './index.js';

type RegisteredTool = {
  remove?: () => void;
  handler?: (args: unknown) => Promise<unknown>;
};
type RegisteredResource = { remove?: () => void };
type RegisteredPrompt = {
  remove?: () => void;
  handler?: (args: unknown) => Promise<unknown>;
};

type ServerInternals = {
  _registeredTools?: Record<string, RegisteredTool>;
  _registeredResources?: Record<string, RegisteredResource>;
  _registeredPrompts?: Record<string, RegisteredPrompt>;
};

export interface BundledResourceRegistration {
  name: string;
  uri: string;
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface McpBundlerServerAdapterOptions {
  toolPrefix?: string;
  promptPrefix?: string;
  mapToolName?: (tool: Tool) => string;
  mapPromptName?: (prompt: Prompt) => string;
  mapResource?: (resource: Resource) => BundledResourceRegistration;
}

/** Minimal shape of a JSON-Schema node we read when mapping to zod. */
type JsonSchemaNode = {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  items?: JsonSchemaNode;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  /** OpenAPI 3.0 nullability (older schemars / OpenAPI-derived schemas). */
  nullable?: boolean;
  /** Local reference into the root's `$defs` / `definitions`. */
  $ref?: string;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  $defs?: Record<string, JsonSchemaNode>;
  definitions?: Record<string, JsonSchemaNode>;
};

/**
 * Resolution context threaded through the whole mapping: the root's definition
 * table (so `$ref`s resolve) plus the set of definition names currently being
 * resolved (so a self-referential `$ref` terminates instead of looping).
 */
type ResolveCtx = {
  defs: Record<string, JsonSchemaNode>;
  seen: ReadonlySet<string>;
  /** Ref-resolution depth, bounded to keep deep/recursive $ref chains from
   *  overflowing the stack (the `seen` set stops cycles, not linear depth). */
  depth: number;
};

/** Max $ref-resolution depth before we stop and stay permissive. */
const MAX_REF_DEPTH = 64;

/**
 * Map a single JSON-Schema node to a zod type, HONORING its declared `type`.
 *
 * Why this matters: the produced zod schema is what the MCP SDK re-serializes
 * back to JSON Schema when advertising a proxied variant tool upstream. If we
 * collapse every field to `z.any()` (as this once did), the re-exposed tool
 * carries NO type information, so a client/model sends scalars with the wrong
 * JSON type (a number as "3999", a boolean as "false"). The downstream app then
 * validates strictly against its real typed schema and rejects them — a bogus
 * SCHEMA_INVALID. Preserving the type keeps args faithful end-to-end.
 * See kunobi-frontend#2565.
 *
 * Deliberately NOT coercing (no `z.coerce.*`): coercion would let a wrong-typed
 * value through here and mask the real contract, and string→boolean coercion is
 * unsound ("false" is truthy). A genuinely untyped node still falls back to
 * `z.any()`, so anything the schema doesn't describe stays permissive.
 */
/** Build a union of zod types; collapses to the single member when len 1. */
function zodUnion(members: z.ZodTypeAny[]): z.ZodTypeAny {
  if (members.length === 0) return z.any();
  if (members.length === 1) return members[0];
  return z.union(
    members as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]],
  );
}

/** Map ONE JSON-Schema `type` name to zod, reading `items`/`properties` off the node. */
function zodForType(
  type: string,
  node: JsonSchemaNode,
  ctx: ResolveCtx,
): z.ZodTypeAny {
  switch (type) {
    case 'string':
      return z.string();
    case 'integer':
    case 'number':
      // Map BOTH to `z.number()` — deliberately NOT `z.number().int()`. Under
      // zod 4, `.int()` enforces `Number.isSafeInteger`, so it would reject a
      // `uint64`/`int64` value above 2^53 that the downstream (a Rust u64)
      // accepts and that the old `z.any()` mapping passed through — a
      // regression on a real schemars shape (`{type:["integer","null"],
      // format:"uint64"}`). A plain number still fixes the core bug (a scalar
      // is advertised as a number, not stringified) without that ceiling.
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array':
      return z.array(jsonNodeToZod(node.items, ctx));
    case 'object':
      return objectShape(node, ctx);
    default:
      // Unknown type: stay permissive rather than reject.
      return z.any();
  }
}

/**
 * Resolve a local `#/$defs/Name` (or `#/definitions/Name`) reference against the
 * root table. Unknown/external/circular refs stay permissive (`z.any()`) — the
 * proxy must never newly reject a value it cannot positively type.
 */
function resolveRef(ref: string, ctx: ResolveCtx): z.ZodTypeAny {
  if (ctx.depth >= MAX_REF_DEPTH) return z.any(); // depth bound (deep chains)
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match) return z.any(); // external or non-local ref
  const name = match[1];
  if (ctx.seen.has(name)) return z.any(); // cycle guard
  const def = ctx.defs[name];
  if (!def) return z.any(); // dangling ref
  const seen = new Set(ctx.seen);
  seen.add(name);
  return jsonNodeToZod(def, { defs: ctx.defs, seen, depth: ctx.depth + 1 });
}

/** A node is nullable if `null` is a `type` member or `nullable: true` (OpenAPI). */
function nodeIsNullable(node: JsonSchemaNode): boolean {
  if (node.nullable === true) return true;
  return Array.isArray(node.type) && node.type.includes('null');
}

/**
 * Base scalar type for an enum node: its declared `type` (minus `null`), or —
 * when untyped — inferred from the members if they share one primitive type.
 * `undefined` means "can't tell" → caller stays permissive (`z.any()`).
 */
function enumBaseType(node: JsonSchemaNode): string | undefined {
  if (typeof node.type === 'string' && node.type !== 'null') return node.type;
  if (Array.isArray(node.type)) {
    const t = node.type.find((x) => x !== 'null');
    if (t) return t;
  }
  const members = (node.enum ?? []).filter((v) => v !== null);
  if (members.length === 0) return undefined;
  const t = typeof members[0];
  if (
    (t === 'string' || t === 'number' || t === 'boolean') &&
    members.every((v) => typeof v === t)
  ) {
    return t;
  }
  return undefined; // mixed / object / array members → permissive
}

function jsonNodeToZod(
  node: JsonSchemaNode | undefined,
  ctx: ResolveCtx,
): z.ZodTypeAny {
  if (!node || typeof node !== 'object') {
    return z.any();
  }

  // A local `$ref` resolves against the root `$defs`; this is how schemars
  // types its enum fields (`mode`, `mcp_failure_mode`, `limit_kind`, …).
  if (typeof node.$ref === 'string') {
    return resolveRef(node.$ref, ctx);
  }

  // `anyOf`/`oneOf` → a union of the mapped members. Covers the schemars
  // nullable-enum shape `anyOf:[{$ref:...},{type:"null"}]`. Union is >= "one of"
  // (looser than oneOf's "exactly one"), which is the safe direction for a
  // proxy: never reject a value a branch accepts; the downstream is strict.
  const branches = node.anyOf ?? node.oneOf;
  if (Array.isArray(branches) && branches.length > 0) {
    return zodUnion(branches.map((b) => jsonNodeToZod(b, ctx)));
  }

  // An enum: ADVERTISE the known values as hints (the model sees `llm`/`mcp`)
  // while VALIDATING only the base type — so a downstream value outside the
  // advertised list (e.g. a Rust serde `#[serde(alias = "…")]`, which schemars
  // does NOT emit into the enum) still forwards instead of being rejected (a
  // regression found by cross-family review). We do this with a union of the
  // member literals AND the base type: the literals surface in the emitted JSON
  // schema, and the trailing base-type branch accepts any other same-typed
  // value. A wrong TYPE (a stringified number) is still rejected. Nullable when
  // the node declares it or `null` is itself a member.
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const base = enumBaseType(node);
    let mapped: z.ZodTypeAny;
    if (!base) {
      mapped = z.any(); // mixed / object / array members → permissive
    } else {
      const baseZod = zodForType(base, node, ctx);
      const literals = node.enum
        .filter((v) => v !== null)
        .map((v) => z.literal(v as Parameters<typeof z.literal>[0]));
      mapped = literals.length > 0 ? zodUnion([...literals, baseZod]) : baseZod;
    }
    const nullable = nodeIsNullable(node) || node.enum.includes(null);
    return nullable ? mapped.nullable() : mapped;
  }

  // JSON Schema allows `type` to be an array (a union) — and schemars encodes
  // every `Option<T>` this way, e.g. `["integer","null"]`. Map EVERY member and
  // union them, so a nullable field still accepts `null` (field-clearing) while
  // a wrong-typed scalar is still rejected. Taking only the first member would
  // drop the `null` branch and break clearing — a regression.
  if (Array.isArray(node.type)) {
    return zodUnion(node.type.map((t) => zodForType(t, node, ctx)));
  }
  if (typeof node.type === 'string') {
    const mapped = zodForType(node.type, node, ctx);
    // OpenAPI-style nullable (`{type:"string",nullable:true}`) — accept null too.
    return node.nullable === true ? mapped.nullable() : mapped;
  }

  // No `type` (anyOf / oneOf / $ref / allOf / untyped): stay permissive. The
  // downstream server validates these strictly against its real schema; the
  // proxy's job is only to preserve types it can see, never to newly reject.
  return z.any();
}

/** Build the zod object shape for one object node, under a resolution context. */
function objectShape(
  schema: JsonSchemaNode | undefined,
  ctx: ResolveCtx,
): z.ZodTypeAny {
  const properties = schema?.properties;
  // A malformed `required` (not an array — e.g. a hand-written or non-schemars
  // downstream) must not throw during registration and kill the whole tool.
  const required = Array.isArray(schema?.required) ? schema.required : [];

  if (!properties || Object.keys(properties).length === 0) {
    return z.object({}).passthrough();
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, prop] of Object.entries(properties)) {
    let field = jsonNodeToZod(prop, ctx);
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

export function zodShapeFromJsonSchema(
  inputSchema: Tool['inputSchema'],
): z.ZodTypeAny {
  const schema = inputSchema as JsonSchemaNode | undefined;
  // The definition table lives at the ROOT; capture it once and thread it down
  // so nested `$ref`s (which carry no defs of their own) still resolve.
  const ctx: ResolveCtx = {
    defs: schema?.$defs ?? schema?.definitions ?? {},
    seen: new Set(),
    depth: 0,
  };
  return objectShape(schema, ctx);
}

function promptArgsShape(prompt: Prompt): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const arg of prompt.arguments ?? []) {
    let field: z.ZodTypeAny = z.string();
    if (arg.description) {
      field = field.describe(arg.description);
    }
    if (!arg.required) {
      field = field.optional();
    }
    shape[arg.name] = field;
  }
  return shape;
}

export class McpBundlerServerAdapter {
  private readonly bundler: McpBundler;
  private readonly options: McpBundlerServerAdapterOptions;
  private readonly registeredToolNames = new Set<string>();
  private readonly registeredResourceUris = new Set<string>();
  private readonly registeredPromptNames = new Set<string>();

  constructor(
    bundler: McpBundler,
    options: McpBundlerServerAdapterOptions = {},
  ) {
    this.bundler = bundler;
    this.options = options;
  }

  async registerTools(server: McpServer): Promise<void> {
    const tools = await this.bundler.listTools();

    for (const tool of tools) {
      const registeredName =
        this.options.mapToolName?.(tool) ??
        `${this.options.toolPrefix ?? ''}${tool.name}`;
      const inputSchema = zodShapeFromJsonSchema(tool.inputSchema);
      const originalName = tool.name;

      server.registerTool(
        registeredName,
        {
          title: tool.title,
          description: tool.description,
          inputSchema,
          annotations: tool.annotations,
        },
        async (args) => {
          return this.bundler.callTool(
            originalName,
            args as Record<string, unknown> | undefined,
          );
        },
      );

      this.registeredToolNames.add(registeredName);
    }
  }

  unregisterTools(server: McpServer): void {
    const serverAny = server as unknown as ServerInternals;
    if (!serverAny._registeredTools) return;

    for (const name of this.registeredToolNames) {
      const tool = serverAny._registeredTools[name];
      if (tool?.remove) {
        tool.remove();
      }
    }
    this.registeredToolNames.clear();
  }

  async registerResources(server: McpServer): Promise<void> {
    const resources = await this.bundler.listResources();
    if (resources.length === 0) return;

    for (const resource of resources) {
      const registered = this.options.mapResource?.(resource) ?? {
        name: resource.name,
        uri: resource.uri,
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
      };

      server.registerResource(
        registered.name,
        registered.uri,
        {
          title: registered.title ?? resource.title,
          description: registered.description ?? resource.description,
          mimeType: registered.mimeType ?? resource.mimeType,
        },
        async () => {
          return this.bundler.readResource(resource.uri);
        },
      );

      this.registeredResourceUris.add(registered.uri);
    }
  }

  unregisterResources(server: McpServer): void {
    const serverAny = server as unknown as ServerInternals;
    if (!serverAny._registeredResources) return;

    for (const uri of this.registeredResourceUris) {
      const resource = serverAny._registeredResources[uri];
      if (resource?.remove) {
        resource.remove();
      }
    }
    this.registeredResourceUris.clear();
  }

  async registerPrompts(server: McpServer): Promise<void> {
    const prompts = await this.bundler.listPrompts();
    if (prompts.length === 0) return;

    for (const prompt of prompts) {
      const registeredName =
        this.options.mapPromptName?.(prompt) ??
        `${this.options.promptPrefix ?? ''}${prompt.name}`;
      const argsSchema = promptArgsShape(prompt);
      const originalName = prompt.name;

      server.registerPrompt(
        registeredName,
        {
          title: prompt.title,
          description: prompt.description,
          argsSchema:
            Object.keys(argsSchema).length > 0 ? argsSchema : undefined,
        },
        async (args) => {
          return this.bundler.getPrompt(
            originalName,
            args as Record<string, string> | undefined,
          );
        },
      );

      this.registeredPromptNames.add(registeredName);
    }
  }

  unregisterPrompts(server: McpServer): void {
    const serverAny = server as unknown as ServerInternals;
    if (!serverAny._registeredPrompts) return;

    for (const name of this.registeredPromptNames) {
      const prompt = serverAny._registeredPrompts[name];
      if (prompt?.remove) {
        prompt.remove();
      }
    }
    this.registeredPromptNames.clear();
  }
}
