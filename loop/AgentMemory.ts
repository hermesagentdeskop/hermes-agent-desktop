// rev-a2b81d-20260901 AgentMemory.ts
import {
  ChatMessage,
  MemoryConfig,
  MemoryEntry,
  MessageRole,
} from '../../schema/HermesTypes';

/**
 * AgentMemory — manages conversation history and optional persistent memory.
 * Implements a sliding-window strategy to keep token usage bounded.
 */
export class AgentMemory {
  private config: MemoryConfig;
  private messages: MemoryEntry[] = [];
  private sessionId: string;

  constructor(config: MemoryConfig, sessionId?: string) {
    this.config = config;
    this.sessionId = sessionId ?? `session_${Date.now()}`;
  }

  /** Add a chat message to memory. Evicts oldest messages when limit is exceeded. */
  async addMessage(message: ChatMessage): Promise<void> {
    const entry: MemoryEntry = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      content: message.content,
      role: message.role,
      timestamp: message.timestamp,
      metadata: {
        toolCallId: message.toolCallId,
        toolName: message.toolName,
      },
    };

    this.messages.push(entry);
    this.evictIfNeeded();

    if (this.config.persistAcrossSessions) {
      await this.persist(entry);
    }
  }

  /** Get the last N messages as ChatMessage objects, respecting maxMessages. */
  async getHistory(maxMessages?: number): Promise<ChatMessage[]> {
    const limit = maxMessages ?? this.config.maxMessages;
    const slice = this.messages.slice(-limit);

    return slice.map((e) => ({
      role: e.role as MessageRole,
      content: e.content,
      timestamp: e.timestamp,
      toolCallId: e.metadata?.toolCallId as string | undefined,
      toolName: e.metadata?.toolName as string | undefined,
    }));
  }

  /** Search memory entries by text substring (simple keyword search). */
  search(query: string, limit = 10): MemoryEntry[] {
    const lower = query.toLowerCase();
    return this.messages
      .filter((e) => e.content.toLowerCase().includes(lower))
      .slice(-limit);
  }

  /** Estimate total tokens in current memory (rough approximation: 1 token ≈ 4 chars). */
  estimateTokenCount(): number {
    const totalChars = this.messages.reduce((sum, e) => sum + e.content.length, 0);
    return Math.ceil(totalChars / 4);
  }

  /** Clear all in-memory messages (does not affect persisted storage). */
  clear(): void {
    this.messages = [];
  }

  /** Return current message count. */
  get size(): number {
    return this.messages.length;
  }

  /** Return the session ID for this memory instance. */
  get id(): string {
    return this.sessionId;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private evictIfNeeded(): void {
    // Evict by message count
    while (this.messages.length > this.config.maxMessages) {
      // Always preserve the system message at index 0
      const systemIdx = this.messages.findIndex((m) => m.role === 'system');
      const evictIdx = systemIdx === 0 ? 1 : 0;
      if (evictIdx < this.messages.length) {
        this.messages.splice(evictIdx, 1);
      } else {
        break;
      }
    }

    // Evict by estimated token count
    while (this.estimateTokenCount() > this.config.maxTokens && this.messages.length > 1) {
      const systemIdx = this.messages.findIndex((m) => m.role === 'system');
      const evictIdx = systemIdx === 0 ? 1 : 0;
      this.messages.splice(evictIdx, 1);
    }
  }

  /** Persist a single entry to disk (localStorage in renderer, JSON file in main process). */
  private async persist(_entry: MemoryEntry): Promise<void> {
    // In a real Electron app this would use electron-store or write to
    // app.getPath('userData')/memory/<sessionId>.jsonl
    // Stubbed here as the actual IPC bridge is app-specific.
    if (typeof window !== 'undefined' && window.localStorage) {
      const key = `hermes_memory_${this.sessionId}`;
      const existing = JSON.parse(window.localStorage.getItem(key) ?? '[]') as MemoryEntry[];
      existing.push(_entry);
      // Keep only last 200 entries in localStorage
      const trimmed = existing.slice(-200);
      window.localStorage.setItem(key, JSON.stringify(trimmed));
    }
  }

  /** Load persisted messages for this session from localStorage (renderer process). */
  async loadFromStorage(): Promise<void> {
    if (!this.config.persistAcrossSessions) return;
    if (typeof window !== 'undefined' && window.localStorage) {
      const key = `hermes_memory_${this.sessionId}`;
      const stored = JSON.parse(window.localStorage.getItem(key) ?? '[]') as MemoryEntry[];
      this.messages = stored;
    }
  }
}
