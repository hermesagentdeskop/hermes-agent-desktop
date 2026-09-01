// rev-a2b81d-20260901 HermesAgent.ts
import { EventEmitter } from 'events';
import {
  AgentConfig,
  AgentRun,
  AgentStatus,
  AgentTask,
  ChatMessage,
  HermesEvent,
  LLMResponse,
  TaskStatus,
  TokenUsage,
  ToolCall,
  ToolResult,
} from '../../schema/HermesTypes';
import { AgentMemory } from './AgentMemory';
import { TaskPlanner } from './TaskPlanner';
import { ToolRegistry } from './ToolRegistry';
import { ApiRouter } from '../llm/ApiRouter';

/**
 * HermesAgent — main orchestrator implementing the ReAct loop.
 * Reason → Act → Observe → repeat until goal achieved or maxIterations reached.
 */
export class HermesAgent extends EventEmitter {
  private config: AgentConfig;
  private memory: AgentMemory;
  private planner: TaskPlanner;
  private tools: ToolRegistry;
  private router: ApiRouter;
  private currentRun: AgentRun | null = null;
  private abortController: AbortController | null = null;

  constructor(
    config: AgentConfig,
    memory: AgentMemory,
    planner: TaskPlanner,
    tools: ToolRegistry,
    router: ApiRouter,
  ) {
    super();
    this.config = config;
    this.memory = memory;
    this.planner = planner;
    this.tools = tools;
    this.router = router;
  }

  /** Start a new agent run for the given goal. Returns the completed AgentRun. */
  async run(goal: string): Promise<AgentRun> {
    if (this.currentRun && this.currentRun.status === 'thinking') {
      throw new Error('Agent is already running. Call stop() first.');
    }

    this.abortController = new AbortController();
    const run = this.createRun(goal);
    this.currentRun = run;

    this.emit('agent:start', this.makeEvent('agent:start', { runId: run.id, goal }));
    this.setStatus('thinking');

    try {
      const history = await this.memory.getHistory(this.config.memory.maxMessages);
      run.messages.push(...history);

      const userMessage: ChatMessage = {
        role: 'user',
        content: goal,
        timestamp: Date.now(),
      };
      run.messages.push(userMessage);
      await this.memory.addMessage(userMessage);

      const tasks = await this.planner.decompose(goal, this.config.tools);
      run.tasks = tasks;

      await this.reactLoop(run);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      run.error = message;
      run.status = 'error';
      this.emit('agent:error', this.makeEvent('agent:error', { runId: run.id, error: message }));
    } finally {
      run.finishedAt = Date.now();
      if (run.status !== 'error' && run.status !== 'cancelled') {
        run.status = 'done';
      }
      this.setStatus(run.status as AgentStatus);
      this.currentRun = null;
    }

    return run;
  }

  /** Abort the currently running agent. */
  stop(): void {
    this.abortController?.abort();
    if (this.currentRun) this.currentRun.status = 'cancelled';
    this.setStatus('cancelled');
  }

  getCurrentRun(): Readonly<AgentRun> | null {
    return this.currentRun;
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private async reactLoop(run: AgentRun): Promise<void> {
    const signal = this.abortController!.signal;

    for (let i = 0; i < this.config.maxIterations; i++) {
      if (signal.aborted) { run.status = 'cancelled'; return; }

      run.iterations = i + 1;
      this.setStatus('thinking');

      const toolDefs = this.tools.getDefinitions(this.config.tools);
      const response: LLMResponse = await this.router.chat(
        run.messages,
        toolDefs,
        this.config.model,
        signal,
      );

      this.accumulateUsage(run, response.usage);

      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: response.content,
        timestamp: Date.now(),
      };
      run.messages.push(assistantMsg);
      await this.memory.addMessage(assistantMsg);
      this.emit('agent:message', this.makeEvent('agent:message', { runId: run.id, message: assistantMsg }));

      // No tool calls — model has finished
      if (!response.toolCalls || response.toolCalls.length === 0) {
        this.markTasksComplete(run.tasks, response.content);
        break;
      }

      // Execute tools and feed results back into context
      this.setStatus('acting');
      for (const toolCall of response.toolCalls) {
        if (signal.aborted) return;
        this.emit('agent:tool_call', this.makeEvent('agent:tool_call', { runId: run.id, toolCall }));
        const result = await this.executeTool(toolCall);
        this.emit('agent:tool_result', this.makeEvent('agent:tool_result', { runId: run.id, result }));

        const toolMsg: ChatMessage = {
          role: 'tool',
          content: result.output,
          toolCallId: result.toolCallId,
          toolName: result.name,
          toolResult: result,
          timestamp: Date.now(),
        };
        run.messages.push(toolMsg);
        await this.memory.addMessage(toolMsg);
      }
    }
  }

  private async executeTool(toolCall: ToolCall): Promise<ToolResult> {
    const start = Date.now();
    try {
      const output = await this.tools.dispatch(toolCall.name, toolCall.input);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
        durationMs: Date.now() - start,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        toolCallId: toolCall.id,
        name: toolCall.name,
        output: `Error executing tool "${toolCall.name}": ${message}`,
        error: message,
        durationMs: Date.now() - start,
      };
    }
  }

  private createRun(goal: string): AgentRun {
    return {
      id: `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      agentId: this.config.id,
      goal,
      status: 'idle',
      iterations: 0,
      messages: [{ role: 'system', content: this.config.systemPrompt, timestamp: Date.now() }],
      tasks: [],
      startedAt: Date.now(),
      tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    };
  }

  private setStatus(status: AgentStatus): void {
    if (this.currentRun) this.currentRun.status = status;
    this.emit('agent:status_change', this.makeEvent('agent:status_change', { status }));
  }

  private accumulateUsage(run: AgentRun, usage: TokenUsage): void {
    run.tokenUsage.promptTokens += usage.promptTokens;
    run.tokenUsage.completionTokens += usage.completionTokens;
    run.tokenUsage.totalTokens += usage.totalTokens;
  }

  private markTasksComplete(tasks: AgentTask[], response: string): void {
    const lower = response.toLowerCase();
    if (lower.includes('done') || lower.includes('completed') || lower.includes('finished')) {
      for (const task of tasks) {
        if (task.status === 'in_progress') {
          task.status = 'completed' as TaskStatus;
          task.completedAt = Date.now();
        }
      }
    }
  }

  private makeEvent<T>(type: string, payload: T): HermesEvent<T> {
    return { type: type as HermesEvent['type'], payload, timestamp: Date.now() };
  }
}
