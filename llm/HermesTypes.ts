// rev-a2b81d-20260901 HermesTypes.ts
// Shared TypeScript types for Hermes Agent Desktop
// All core interfaces used across agent, tools, llm, and ui layers

export type ModelProvider = 'ollama' | 'openai' | 'anthropic' | 'google' | 'xai' | 'custom';

export type ToolName =
  | 'filesystem'
  | 'terminal'
  | 'websearch'
  | 'browser'
  | 'memory'
  | 'code_executor';

export type AgentStatus =
  | 'idle'
  | 'thinking'
  | 'acting'
  | 'waiting_for_tool'
  | 'done'
  | 'error'
  | 'cancelled';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

// ─── LLM / Model ────────────────────────────────────────────────────────────

export interface ModelConfig {
  provider: ModelProvider;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  temperature: number;
  maxTokens: number;
  contextWindow: number;
  topP?: number;
  stopSequences?: string[];
}

export interface ChatMessage {
  role: MessageRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: ToolResult;
  timestamp: number;
}

export interface StreamChunk {
  delta: string;
  done: boolean;
  usage?: TokenUsage;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage: TokenUsage;
  model: string;
  finishReason: 'stop' | 'tool_calls' | 'length' | 'error';
}

// ─── Tool System ─────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: ToolName | string;
  description: string;
  parameters: JSONSchema;
  dangerous?: boolean;  // requires explicit user confirmation
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  output: string;
  error?: string;
  durationMs: number;
}

export interface JSONSchema {
  type: string;
  properties?: Record<string, JSONSchema>;
  required?: string[];
  description?: string;
  enum?: unknown[];
  items?: JSONSchema;
  [key: string]: unknown;
}

// ─── Agent ───────────────────────────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: ModelConfig;
  tools: ToolName[];
  maxIterations: number;
  memory: MemoryConfig;
  persona?: PersonaConfig;
}

export interface AgentRun {
  id: string;
  agentId: string;
  goal: string;
  status: AgentStatus;
  iterations: number;
  messages: ChatMessage[];
  tasks: AgentTask[];
  startedAt: number;
  finishedAt?: number;
  error?: string;
  tokenUsage: TokenUsage;
}

export interface AgentTask {
  id: string;
  runId: string;
  title: string;
  description: string;
  status: TaskStatus;
  subtasks: AgentTask[];
  toolCallsUsed: string[];
  createdAt: number;
  completedAt?: number;
  result?: string;
}

// ─── Memory ──────────────────────────────────────────────────────────────────

export interface MemoryConfig {
  enabled: boolean;
  maxTokens: number;
  persistAcrossSessions: boolean;
  vectorSearchEnabled: boolean;
  maxMessages: number;
}

export interface MemoryEntry {
  id: string;
  content: string;
  role: MessageRole;
  timestamp: number;
  embedding?: number[];
  metadata?: Record<string, unknown>;
}

// ─── Persona ─────────────────────────────────────────────────────────────────

export interface PersonaConfig {
  id: string;
  name: string;
  avatar?: string;
  systemPrompt: string;
  allowedTools: ToolName[];
  model?: Partial<ModelConfig>;
}

// ─── Workflow ─────────────────────────────────────────────────────────────────

export type NodeType = 'trigger' | 'agent' | 'tool' | 'condition' | 'transform' | 'output';

export interface WorkflowNode {
  id: string;
  type: NodeType;
  label: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
  inputs: string[];
  outputs: string[];
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  condition?: string;
}

export interface Workflow {
  id: string;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: number;
  updatedAt: number;
}

// ─── Kanban ──────────────────────────────────────────────────────────────────

export interface KanbanColumn {
  id: string;
  title: string;
  color: string;
  taskIds: string[];
}

export interface KanbanCard {
  id: string;
  title: string;
  description: string;
  columnId: string;
  agentRunId?: string;
  tags: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
  createdAt: number;
  dueAt?: number;
}

export interface KanbanBoard {
  id: string;
  name: string;
  columns: KanbanColumn[];
  cards: KanbanCard[];
}

// ─── Settings ────────────────────────────────────────────────────────────────

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  language: string;
  providers: Record<ModelProvider, ProviderSettings>;
  defaultAgentConfig: Partial<AgentConfig>;
  ollamaBaseUrl: string;
  gatewayEnabled: boolean;
  gatewayPort: number;
  telemetryEnabled: boolean;
}

export interface ProviderSettings {
  apiKey?: string;
  baseUrl?: string;
  enabled: boolean;
  defaultModel?: string;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export type HermesEventType =
  | 'agent:start'
  | 'agent:stop'
  | 'agent:status_change'
  | 'agent:message'
  | 'agent:tool_call'
  | 'agent:tool_result'
  | 'agent:error'
  | 'model:stream_chunk'
  | 'model:response'
  | 'workflow:start'
  | 'workflow:step'
  | 'workflow:done';

export interface HermesEvent<T = unknown> {
  type: HermesEventType;
  payload: T;
  timestamp: number;
}
