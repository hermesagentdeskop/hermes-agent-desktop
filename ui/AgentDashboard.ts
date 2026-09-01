// rev-a2b81d-20260901 AgentDashboard.ts
import { EventEmitter } from 'events';
import {
  AgentConfig,
  AgentRun,
  AgentStatus,
  AppSettings,
  ChatMessage,
  KanbanBoard,
  ModelProvider,
  Workflow,
} from '../../schema/HermesTypes';

export interface DashboardState {
  status: AgentStatus;
  currentRun: AgentRun | null;
  messageHistory: ChatMessage[];
  tokenCount: number;
  activeModel: string;
  activeProvider: ModelProvider;
  sidebarOpen: boolean;
  activeTab: 'chat' | 'kanban' | 'workflow' | 'settings';
  logLines: string[];
}

export interface DashboardActions {
  sendMessage(text: string): void;
  stopAgent(): void;
  clearHistory(): void;
  setTab(tab: DashboardState['activeTab']): void;
  toggleSidebar(): void;
  updateSettings(partial: Partial<AppSettings>): void;
  loadWorkflow(id: string): void;
  exportHistory(): string;
}

/**
 * AgentDashboard — main UI state manager for the Hermes Agent Desktop dashboard.
 * Acts as a ViewModel: holds reactive state and exposes action methods.
 * The actual rendering is handled by the Electron renderer (React/Svelte/vanilla).
 */
export class AgentDashboard extends EventEmitter implements DashboardActions {
  private state: DashboardState;
  private agentConfig: AgentConfig;
  private settings: AppSettings;

  constructor(agentConfig: AgentConfig, settings: AppSettings) {
    super();
    this.agentConfig = agentConfig;
    this.settings = settings;
    this.state = this.initialState();
  }

  /** Get a readonly snapshot of current dashboard state. */
  getState(): Readonly<DashboardState> {
    return { ...this.state };
  }

  // ─── Actions ──────────────────────────────────────────────────────────────

  sendMessage(text: string): void {
    if (!text.trim()) return;
    const msg: ChatMessage = {
      role: 'user',
      content: text.trim(),
      timestamp: Date.now(),
    };
    this.addMessage(msg);
    this.setStatus('thinking');
    this.log(`User: ${text.slice(0, 100)}${text.length > 100 ? '…' : ''}`);
    this.emit('dashboard:send_message', { text });
  }

  stopAgent(): void {
    this.setStatus('cancelled');
    this.log('Agent stopped by user.');
    this.emit('dashboard:stop_agent');
  }

  clearHistory(): void {
    this.state.messageHistory = [];
    this.state.tokenCount = 0;
    this.state.logLines = [];
    this.emit('dashboard:state_change', this.state);
  }

  setTab(tab: DashboardState['activeTab']): void {
    this.state.activeTab = tab;
    this.emit('dashboard:state_change', this.state);
  }

  toggleSidebar(): void {
    this.state.sidebarOpen = !this.state.sidebarOpen;
    this.emit('dashboard:state_change', this.state);
  }

  updateSettings(partial: Partial<AppSettings>): void {
    this.settings = { ...this.settings, ...partial };
    this.emit('dashboard:settings_change', this.settings);
  }

  loadWorkflow(id: string): void {
    this.log(`Loading workflow: ${id}`);
    this.emit('dashboard:load_workflow', { id });
  }

  exportHistory(): string {
    const lines = this.state.messageHistory.map((m) => {
      const time = new Date(m.timestamp).toISOString();
      const role = m.role.toUpperCase().padEnd(10);
      return `[${time}] ${role} ${m.content}`;
    });
    return lines.join('\n');
  }

  // ─── Agent event handlers (called by HermesAgent events) ─────────────────

  onAgentMessage(msg: ChatMessage): void {
    this.addMessage(msg);
    if (msg.role === 'assistant') {
      this.log(`Agent: ${msg.content.slice(0, 120)}${msg.content.length > 120 ? '…' : ''}`);
    }
  }

  onAgentStatusChange(status: AgentStatus): void {
    this.setStatus(status);
  }

  onRunStart(run: AgentRun): void {
    this.state.currentRun = run;
    this.log(`Run started: ${run.id} | Goal: ${run.goal.slice(0, 80)}`);
    this.emit('dashboard:state_change', this.state);
  }

  onRunComplete(run: AgentRun): void {
    this.state.currentRun = run;
    this.state.tokenCount += run.tokenUsage.totalTokens;
    this.log(`Run complete: ${run.id} | ${run.iterations} iterations | ${run.tokenUsage.totalTokens} tokens`);
    this.setStatus('idle');
  }

  onToolCall(toolName: string, input: unknown): void {
    this.log(`Tool call: ${toolName} | ${JSON.stringify(input).slice(0, 80)}`);
  }

  onToolResult(toolName: string, result: string): void {
    this.log(`Tool result: ${toolName} → ${result.slice(0, 80)}${result.length > 80 ? '…' : ''}`);
  }

  // ─── Workflow / Kanban accessors ──────────────────────────────────────────

  setWorkflows(workflows: Workflow[]): void {
    this.emit('dashboard:workflows_loaded', workflows);
  }

  setKanbanBoard(board: KanbanBoard): void {
    this.emit('dashboard:kanban_loaded', board);
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private addMessage(msg: ChatMessage): void {
    this.state.messageHistory.push(msg);
    // Keep last 200 messages in dashboard memory
    if (this.state.messageHistory.length > 200) {
      this.state.messageHistory = this.state.messageHistory.slice(-200);
    }
    this.emit('dashboard:message', msg);
    this.emit('dashboard:state_change', this.state);
  }

  private setStatus(status: AgentStatus): void {
    this.state.status = status;
    this.emit('dashboard:status_change', status);
    this.emit('dashboard:state_change', this.state);
  }

  private log(line: string): void {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    this.state.logLines.push(`[${ts}] ${line}`);
    if (this.state.logLines.length > 500) {
      this.state.logLines = this.state.logLines.slice(-500);
    }
    this.emit('dashboard:log', line);
  }

  private initialState(): DashboardState {
    return {
      status: 'idle',
      currentRun: null,
      messageHistory: [],
      tokenCount: 0,
      activeModel: this.agentConfig.model.model,
      activeProvider: this.agentConfig.model.provider,
      sidebarOpen: true,
      activeTab: 'chat',
      logLines: [],
    };
  }
}
