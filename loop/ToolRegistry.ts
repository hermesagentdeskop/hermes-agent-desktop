// rev-a2b81d-20260901 ToolRegistry.ts
import { JSONSchema, ToolDefinition, ToolName } from '../../schema/HermesTypes';

type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

interface RegisteredTool {
  definition: ToolDefinition;
  handler: ToolHandler;
}

/**
 * ToolRegistry — central registry for all agent tools.
 * Tools register themselves with a definition (schema) and an async handler.
 * The agent calls dispatch() to execute a tool by name.
 */
export class ToolRegistry {
  private registry = new Map<string, RegisteredTool>();

  /** Register a tool. Throws if a tool with the same name already exists. */
  register(definition: ToolDefinition, handler: ToolHandler): void {
    if (this.registry.has(definition.name)) {
      throw new Error(`Tool "${definition.name}" is already registered.`);
    }
    this.registry.set(definition.name, { definition, handler });
  }

  /** Re-register (overwrite) a tool — useful for hot-reloading during dev. */
  registerOrReplace(definition: ToolDefinition, handler: ToolHandler): void {
    this.registry.set(definition.name, { definition, handler });
  }

  /** Unregister a tool by name. */
  unregister(name: string): boolean {
    return this.registry.delete(name);
  }

  /** Return the tool definitions for the given tool names (for LLM function-calling). */
  getDefinitions(names?: ToolName[]): ToolDefinition[] {
    if (!names || names.length === 0) {
      return Array.from(this.registry.values()).map((t) => t.definition);
    }
    return names
      .map((name) => this.registry.get(name as string)?.definition)
      .filter((d): d is ToolDefinition => d !== undefined);
  }

  /** Dispatch a tool call. Validates name and calls the registered handler. */
  async dispatch(name: string, input: Record<string, unknown>): Promise<unknown> {
    const tool = this.registry.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: "${name}". Available: ${this.listNames().join(', ')}`);
    }

    const validationError = this.validate(input, tool.definition.parameters);
    if (validationError) {
      throw new Error(`Invalid input for tool "${name}": ${validationError}`);
    }

    return tool.handler(input);
  }

  /** Check if a tool is registered. */
  has(name: string): boolean {
    return this.registry.has(name);
  }

  /** List all registered tool names. */
  listNames(): string[] {
    return Array.from(this.registry.keys());
  }

  /** Return the count of registered tools. */
  get size(): number {
    return this.registry.size;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  /**
   * Minimal JSON Schema validation — checks required fields and basic types.
   * Full AJV-style validation is intentionally avoided to keep dependencies lean.
   */
  private validate(input: Record<string, unknown>, schema: JSONSchema): string | null {
    if (schema.type !== 'object') return null;

    const required = (schema.required ?? []) as string[];
    for (const field of required) {
      if (!(field in input) || input[field] === undefined || input[field] === null) {
        return `Missing required field: "${field}"`;
      }
    }

    if (schema.properties) {
      for (const [key, fieldSchema] of Object.entries(schema.properties)) {
        if (!(key in input)) continue;
        const value = input[key];
        const expectedType = (fieldSchema as JSONSchema).type as string;
        if (expectedType && !this.typeMatches(value, expectedType)) {
          return `Field "${key}" must be of type ${expectedType}, got ${typeof value}`;
        }
      }
    }

    return null;
  }

  private typeMatches(value: unknown, type: string): boolean {
    switch (type) {
      case 'string':  return typeof value === 'string';
      case 'number':  return typeof value === 'number';
      case 'boolean': return typeof value === 'boolean';
      case 'array':   return Array.isArray(value);
      case 'object':  return typeof value === 'object' && !Array.isArray(value) && value !== null;
      default:        return true;
    }
  }
}
