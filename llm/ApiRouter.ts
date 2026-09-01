// rev-a2b81d-20260901 ApiRouter.ts
import https from 'https';
import http from 'http';
import {
  ChatMessage,
  LLMResponse,
  ModelConfig,
  ModelProvider,
  TokenUsage,
  ToolCall,
  ToolDefinition,
} from '../../schema/HermesTypes';
import { OllamaClient } from './OllamaClient';

interface OpenAIMessage {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
}

/**
 * ApiRouter — routes LLM chat requests to the appropriate provider backend.
 * Supports: Ollama (local), OpenAI, Anthropic, Google Gemini, xAI Grok,
 * and any OpenAI-compatible custom endpoint.
 */
export class ApiRouter {
  private ollamaClient: OllamaClient;
  private apiKeys: Partial<Record<ModelProvider, string>>;
  private baseUrls: Partial<Record<ModelProvider, string>>;

  constructor(
    ollamaBaseUrl = 'http://localhost:11434',
    apiKeys: Partial<Record<ModelProvider, string>> = {},
    baseUrls: Partial<Record<ModelProvider, string>> = {},
  ) {
    this.ollamaClient = new OllamaClient(ollamaBaseUrl);
    this.apiKeys = apiKeys;
    this.baseUrls = baseUrls;
  }

  /** Update an API key at runtime (e.g. when user saves settings). */
  setApiKey(provider: ModelProvider, key: string): void {
    this.apiKeys[provider] = key;
  }

  /** Update a custom base URL at runtime. */
  setBaseUrl(provider: ModelProvider, url: string): void {
    this.baseUrls[provider] = url;
  }

  /**
   * Route a chat request to the correct provider.
   * Returns a normalised LLMResponse regardless of which backend was called.
   */
  async chat(
    messages: ChatMessage[],
    toolDefs: ToolDefinition[],
    config: ModelConfig,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    switch (config.provider) {
      case 'ollama':
        return this.ollamaClient.chat(messages, toolDefs, config, signal);

      case 'openai':
      case 'custom':
        return this.openAIChat(messages, toolDefs, config, signal);

      case 'anthropic':
        return this.anthropicChat(messages, toolDefs, config, signal);

      case 'google':
        return this.googleChat(messages, toolDefs, config, signal);

      case 'xai':
        // xAI Grok uses an OpenAI-compatible API
        return this.openAIChat(
          messages,
          toolDefs,
          { ...config, baseUrl: this.baseUrls['xai'] ?? 'https://api.x.ai/v1' },
          signal,
        );

      default:
        throw new Error(`Unsupported provider: ${config.provider}`);
    }
  }

  /** Check which providers are currently configured (have an API key or are local). */
  availableProviders(): ModelProvider[] {
    const available: ModelProvider[] = ['ollama'];
    for (const provider of ['openai', 'anthropic', 'google', 'xai'] as ModelProvider[]) {
      if (this.apiKeys[provider]) available.push(provider);
    }
    return available;
  }

  // ─── OpenAI-compatible ───────────────────────────────────────────────────

  private async openAIChat(
    messages: ChatMessage[],
    toolDefs: ToolDefinition[],
    config: ModelConfig,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const baseUrl = config.baseUrl ?? this.baseUrls[config.provider] ?? 'https://api.openai.com/v1';
    const apiKey = config.apiKey ?? this.apiKeys[config.provider] ?? '';

    const body: Record<string, unknown> = {
      model: config.model,
      messages: this.toOpenAIMessages(messages),
      temperature: config.temperature,
      max_tokens: config.maxTokens,
      stream: false,
    };

    if (toolDefs.length > 0) {
      body['tools'] = toolDefs.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body['tool_choice'] = 'auto';
    }

    const raw = await this.postJson(`${baseUrl}/chat/completions`, body, apiKey, signal);
    const data = JSON.parse(raw) as OpenAIResponse;

    const choice = data.choices[0];
    const toolCalls: ToolCall[] = (choice.message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    const usage: TokenUsage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    };

    return {
      content: choice.message.content ?? '',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      model: data.model,
      finishReason: choice.finish_reason === 'tool_calls' ? 'tool_calls' : 'stop',
    };
  }

  // ─── Anthropic ────────────────────────────────────────────────────────────

  private async anthropicChat(
    messages: ChatMessage[],
    toolDefs: ToolDefinition[],
    config: ModelConfig,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
    const apiKey = config.apiKey ?? this.apiKeys['anthropic'] ?? '';

    const systemMsg = messages.find((m) => m.role === 'system');
    const chatMessages = messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: config.model,
      max_tokens: config.maxTokens,
      messages: chatMessages.map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
      system: systemMsg?.content,
    };

    if (toolDefs.length > 0) {
      body['tools'] = toolDefs.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
    }

    const raw = await this.postJson(`${baseUrl}/v1/messages`, body, apiKey, signal, {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    });

    const data = JSON.parse(raw) as {
      content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
      usage: { input_tokens: number; output_tokens: number };
      model: string;
      stop_reason: string;
    };

    let content = '';
    const toolCalls: ToolCall[] = [];

    for (const block of data.content) {
      if (block.type === 'text') content += block.text ?? '';
      if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id ?? `tc_${Date.now()}`, name: block.name ?? '', input: block.input ?? {} });
      }
    }

    const usage: TokenUsage = {
      promptTokens: data.usage?.input_tokens ?? 0,
      completionTokens: data.usage?.output_tokens ?? 0,
      totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    };

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage,
      model: data.model,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }

  // ─── Google Gemini ────────────────────────────────────────────────────────

  private async googleChat(
    messages: ChatMessage[],
    _toolDefs: ToolDefinition[],
    config: ModelConfig,
    signal?: AbortSignal,
  ): Promise<LLMResponse> {
    const apiKey = config.apiKey ?? this.apiKeys['google'] ?? '';
    const model = config.model.replace(/^models\//, '');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const contents = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }));

    const body = { contents, generationConfig: { maxOutputTokens: config.maxTokens, temperature: config.temperature } };
    const raw = await this.postJson(url, body, '', signal);

    const data = JSON.parse(raw) as {
      candidates: Array<{ content: { parts: Array<{ text: string }> }; finishReason: string }>;
      usageMetadata: { promptTokenCount: number; candidatesTokenCount: number; totalTokenCount: number };
    };

    const text = (data.candidates[0]?.content?.parts ?? []).map((p) => p.text).join('');
    const usage: TokenUsage = {
      promptTokens: data.usageMetadata?.promptTokenCount ?? 0,
      completionTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
    };

    return { content: text, usage, model: config.model, finishReason: 'stop' };
  }

  // ─── HTTP helpers ─────────────────────────────────────────────────────────

  private postJson(
    url: string,
    body: unknown,
    apiKey: string,
    signal?: AbortSignal,
    extraHeaders: Record<string, string> = {},
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const bodyStr = JSON.stringify(body);
      const parsed = new URL(url);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(bodyStr)),
        ...extraHeaders,
      };
      if (apiKey && !extraHeaders['x-api-key']) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }

      const req = lib.request(
        {
          hostname: parsed.hostname,
          port: parsed.port || (isHttps ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: 'POST',
          headers,
          timeout: 120000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk: Buffer) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            } else {
              resolve(data);
            }
          });
        },
      );

      signal?.addEventListener('abort', () => { req.destroy(); reject(new Error('Aborted')); });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
      req.write(bodyStr);
      req.end();
    });
  }

  private toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
    return messages.map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', content: m.content, tool_call_id: m.toolCallId ?? '' };
      }
      return { role: m.role, content: m.content };
    });
  }
}
