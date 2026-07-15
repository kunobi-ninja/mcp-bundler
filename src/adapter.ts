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
};

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
function jsonNodeToZod(node: JsonSchemaNode | undefined): z.ZodTypeAny {
  if (!node || typeof node !== 'object') {
    return z.any();
  }

  // An explicit enum is the tightest constraint; honor it before `type`.
  if (Array.isArray(node.enum) && node.enum.length > 0) {
    const literals = node.enum.map((v) =>
      z.literal(v as Parameters<typeof z.literal>[0]),
    );
    // z.union needs >= 2 members; a single-value enum is just that literal.
    return literals.length === 1
      ? literals[0]
      : z.union(
          literals as unknown as [
            z.ZodTypeAny,
            z.ZodTypeAny,
            ...z.ZodTypeAny[],
          ],
        );
  }

  // JSON Schema allows `type` to be an array (union). Take the first known
  // member; if none map cleanly, fall back to permissive.
  const type = Array.isArray(node.type) ? node.type[0] : node.type;

  switch (type) {
    case 'string':
      return z.string();
    case 'integer':
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array':
      return z.array(jsonNodeToZod(node.items));
    case 'object':
      return zodShapeFromJsonSchema(node as Tool['inputSchema']);
    default:
      // Unknown / absent type: stay permissive rather than reject.
      return z.any();
  }
}

export function zodShapeFromJsonSchema(
  inputSchema: Tool['inputSchema'],
): z.ZodTypeAny {
  const schema = inputSchema as JsonSchemaNode | undefined;
  const properties = schema?.properties;
  const required = schema?.required || [];

  if (!properties || Object.keys(properties).length === 0) {
    return z.object({}).passthrough();
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, prop] of Object.entries(properties)) {
    let field = jsonNodeToZod(prop);
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
