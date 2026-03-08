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
