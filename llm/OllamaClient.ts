// rev-a2b81d-20260901 OllamaClient.ts
import https from 'https';
import http from 'http';
import {
  ChatMessage,
  LLMResponse,
  ModelConfig,
  StreamChunk,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from '../../schema/HermesTypes';

export interface OllamaGenerateRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  options?: {
    temperature?: number;
    top_p?: number;
    num_predict?: number;
    stop?: string[];
  };
  tools?: OllamaToolDef[];
}

interface OllamaToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: object;
  };
}

interface OllamaStreamEvent {
  message?: { role: string; content: string; tool_calls?: OllamaToolCall[] };
  done: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

/**
 * OllamaClient — communicates with a local Ollama HTTP server.
 * Supports /api/chat with tool-call / function-calling (Ollama >= 0.3).
 * Handles streaming and non-streaming responses.
 */
export class OllamaClient {
  private baseUrl: string;
  private timeoutMs: number;

  constructor(baseUrl = 'http://localhost:11434', timeoutMs = 120000) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  /** Send a chat completion request. Returns full response (non-streaming). */
  async chat(
    messages: ChatMessage[],
    toolDefs: ToolDefinition[],
    config: ModelConfig,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const body = this.buildRequest(messages, toolDefs, config, false);
    const raw = await this.post('/api/chat', body, signal);
    return this.parseResponse(raw, config.model);
  }

  /** Send a streaming chat request. Calls onChunk for each delta. */
  async chatStream(
    messages: ChatMessage[],
    toolDefs: ToolDefinition[],
    config: ModelConfig,
    onChunk: (chunk: StreamChunk) => void,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const body = this.buildRequest(messages, toolDefs, config, true);
    return this.postStream('/api/chat', body, config.model, onChunk, signal);
  }

  /** Check if Ollama is running and the model is available. */
  async isAvailable(model: string): Promise<boolean> {
    try {
      const response = await this.get('/api/tags');
      const data = JSON.parse(response) as { models?: Array<{ name: string }> };
      return (data.models ?? []).some((m) => m.name === model || m.name.startsWith(model.split(':')[0]));
    } catch {
      return false;
    }
  }

  /** Pull a model from Ollama registry. Calls onProgress with status lines. */
  async pullModel(model: string, onProgress?: (status: string) => void): Promise<void> {
    const body = JSON.stringify({ model, stream: true });
    await this.postStream(
      '/api/pull',
      body,
      model,
      (chunk) => { if (onProgress) onProgress(chunk.delta); },
      undefined,
    );
  }

  /** List locally available models. */
  async listModels(): Promise<string[]> {
    const raw = await this.get('/api/tags');
    const data = JSON.parse(raw) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private buildRequest(
    messages: ChatMessage[],
    toolDefs: ToolDefinition[],
    config: ModelConfig,
    stream: boolean,
  ): string {
    const body: OllamaGenerateRequest = {
      model: config.model,
      messages: messages.map((m) => ({
        role: m.role === 'tool' ? 'tool' : m.role,
        content: m.content,
      })),
      stream,
      options: {
        temperature: config.temperature,
        top_p: config.topP ?? 0.9,
        num_predict: config.maxTokens,
      },
    };

    if (toolDefs.length > 0) {
      body.tools = toolDefs.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }));
    }

    return JSON.stringify(body);
  }

  private parseResponse(raw: string, model: string): LLMResponse {
    const data = JSON.parse(raw) as OllamaStreamEvent & {
      message?: { role: string; content: string; tool_calls?: OllamaToolCall[] };
    };

    const msg = data.message ?? { role: 'assistant', content: '' };
    const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc, i) => ({
      id: `tc_${Date.now()}_${i}`,
      name: tc.function.name,
      input: tc.function.arguments,
    }));

    const usage: TokenUsage = {
      promptTokens: data.prompt_eval_count ?? 0,
      completionTokens: data.eval_count ?? 0,
      totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
    };

    return {
      content: msg.content ?? '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      model,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }

  private post(path: string, body: string, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk));
          res.on('end', () => resolve(data));
        },
      );

      signal?.addEventListener('abort', () => { req.destroy(); reject(new Error('Aborted')); });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Ollama request timed out')); });
      req.write(body);
      req.end();
    });
  }

  private postStream(
    path: string,
    body: string,
    model: string,
    onChunk: (chunk: StreamChunk) => void,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const isHttps = url.protocol === 'https:';
      const lib = isHttps ? https : http;

      let fullContent = '';
      let lastUsage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      const allToolCalls: ToolCall[] = [];

      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: this.timeoutMs,
        },
        (res) => {
          let buffer = '';
          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const event = JSON.parse(line) as OllamaStreamEvent;
                const delta = event.message?.content ?? '';
                fullContent += delta;

                if (event.prompt_eval_count !== undefined) {
                  lastUsage = {
                    promptTokens: event.prompt_eval_count,
                    completionTokens: event.eval_count ?? 0,
                    totalTokens: (event.prompt_eval_count) + (event.eval_count ?? 0),
                  };
                }

                onChunk({ delta, done: event.done, usage: event.done ? lastUsage : undefined });

                if (event.done) {
                  const toolCalls: ToolCall[] = (event.message?.tool_calls ?? []).map((tc, i) => ({
                    id: `tc_${Date.now()}_${i}`,
                    name: tc.function.name,
                    input: tc.function.arguments,
                  }));
                  allToolCalls.push(...toolCalls);
                }
              } catch {
                // skip malformed line
              }
            }
          });

          res.on('end', () => {
            resolve({
              content: fullContent,
              toolCalls: allToolCalls.length > 0 ? allToolCalls : undefined,
              usage: lastUsage,
              model,
              finishReason: allToolCalls.length > 0 ? 'tool_calls' : 'stop',
            });
          });
        },
      );

      signal?.addEventListener('abort', () => { req.destroy(); reject(new Error('Aborted')); });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Ollama stream timed out')); });
      req.write(body);
      req.end();
    });
  }

  private get(path: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.baseUrl + path);
      const lib = url.protocol === 'https:' ? https : http;
      lib.get(url.toString(), { timeout: this.timeoutMs }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }
}
