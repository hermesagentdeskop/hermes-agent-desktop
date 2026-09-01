// rev-a2b81d-20260901 TaskPlanner.ts
import { AgentTask, TaskStatus, ToolName } from '../../schema/HermesTypes';

interface PlanStep {
  title: string;
  description: string;
  tools: ToolName[];
}

/**
 * TaskPlanner — decomposes a high-level goal into an ordered list of AgentTasks.
 * Uses rule-based heuristics for fast local decomposition without an extra LLM call.
 * For complex goals the first iteration of the ReAct loop will refine the plan.
 */
export class TaskPlanner {
  private readonly runId: string;

  constructor(runId?: string) {
    this.runId = runId ?? `plan_${Date.now()}`;
  }

  /**
   * Decompose a goal string into an ordered task list.
   * Returns a flat list; subtasks can be nested later by the agent.
   */
  async decompose(goal: string, availableTools: ToolName[]): Promise<AgentTask[]> {
    const steps = this.extractSteps(goal, availableTools);
    return steps.map((step, index) => this.createTask(step, index));
  }

  /** Update the status of a task by ID within the provided task list. */
  updateStatus(tasks: AgentTask[], taskId: string, status: TaskStatus): void {
    const task = this.findById(tasks, taskId);
    if (!task) return;
    task.status = status;
    if (status === 'completed' || status === 'failed') {
      task.completedAt = Date.now();
    }
  }

  /** Find the next pending task in the list (depth-first). */
  nextPending(tasks: AgentTask[]): AgentTask | null {
    for (const task of tasks) {
      if (task.status === 'pending') return task;
      const sub = this.nextPending(task.subtasks);
      if (sub) return sub;
    }
    return null;
  }

  /** Return true if all tasks (including subtasks) are done or cancelled. */
  allDone(tasks: AgentTask[]): boolean {
    return tasks.every(
      (t) =>
        (t.status === 'completed' || t.status === 'cancelled' || t.status === 'failed') &&
        this.allDone(t.subtasks),
    );
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private extractSteps(goal: string, availableTools: ToolName[]): PlanStep[] {
    const lower = goal.toLowerCase();
    const steps: PlanStep[] = [];

    // Research / search intent
    if (lower.includes('search') || lower.includes('find') || lower.includes('look up')) {
      if (availableTools.includes('websearch')) {
        steps.push({
          title: 'Search for information',
          description: `Search the web for: ${goal}`,
          tools: ['websearch'],
        });
      }
    }

    // File operations
    if (lower.includes('file') || lower.includes('read') || lower.includes('write') || lower.includes('create')) {
      if (availableTools.includes('filesystem')) {
        steps.push({
          title: 'File system operation',
          description: goal,
          tools: ['filesystem'],
        });
      }
    }

    // Code / terminal
    if (lower.includes('run') || lower.includes('execute') || lower.includes('install') || lower.includes('script')) {
      if (availableTools.includes('terminal')) {
        steps.push({
          title: 'Execute command',
          description: goal,
          tools: ['terminal'],
        });
      }
    }

    // Browser / web automation
    if (lower.includes('browser') || lower.includes('webpage') || lower.includes('navigate') || lower.includes('scrape')) {
      if (availableTools.includes('browser')) {
        steps.push({
          title: 'Browser automation',
          description: goal,
          tools: ['browser'],
        });
      }
    }

    // Generic fallback — single task that will be resolved by the LLM
    if (steps.length === 0) {
      steps.push({
        title: goal.length > 60 ? goal.slice(0, 60) + '…' : goal,
        description: goal,
        tools: availableTools,
      });
    }

    // Always append a "summarise results" step if there are multiple steps
    if (steps.length > 1) {
      steps.push({
        title: 'Summarise results',
        description: 'Collect all results and present a concise summary to the user.',
        tools: [],
      });
    }

    return steps;
  }

  private createTask(step: PlanStep, index: number): AgentTask {
    return {
      id: `task_${this.runId}_${index}_${Math.random().toString(36).slice(2, 6)}`,
      runId: this.runId,
      title: step.title,
      description: step.description,
      status: 'pending',
      subtasks: [],
      toolCallsUsed: step.tools,
      createdAt: Date.now(),
    };
  }

  private findById(tasks: AgentTask[], id: string): AgentTask | null {
    for (const task of tasks) {
      if (task.id === id) return task;
      const sub = this.findById(task.subtasks, id);
      if (sub) return sub;
    }
    return null;
  }
}
