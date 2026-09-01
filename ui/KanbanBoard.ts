// rev-a2b81d-20260901 KanbanBoard.ts
import { EventEmitter } from 'events';
import {
  AgentTask,
  KanbanBoard as KanbanBoardData,
  KanbanCard,
  KanbanColumn,
} from '../../schema/HermesTypes';

export type CardPriority = KanbanCard['priority'];

export interface MoveCardPayload {
  cardId: string;
  fromColumnId: string;
  toColumnId: string;
  toIndex: number;
}

/**
 * KanbanBoard — manages state for the Hermes Agent Desktop Kanban task board.
 * Columns represent agent task lifecycle stages; cards represent tasks/agent runs.
 * Emits events on every mutation so the renderer can re-render reactively.
 */
export class KanbanBoard extends EventEmitter {
  private board: KanbanBoardData;

  constructor(boardData?: Partial<KanbanBoardData>) {
    super();
    this.board = this.createDefaultBoard(boardData);
  }

  // ─── Board access ─────────────────────────────────────────────────────────

  getBoard(): Readonly<KanbanBoardData> {
    return this.board;
  }

  getColumn(id: string): KanbanColumn | undefined {
    return this.board.columns.find((c) => c.id === id);
  }

  getCard(id: string): KanbanCard | undefined {
    return this.board.cards.find((c) => c.id === id);
  }

  getCardsForColumn(columnId: string): KanbanCard[] {
    const col = this.getColumn(columnId);
    if (!col) return [];
    return col.taskIds
      .map((id) => this.board.cards.find((c) => c.id === id))
      .filter((c): c is KanbanCard => c !== undefined);
  }

  // ─── Column operations ────────────────────────────────────────────────────

  addColumn(title: string, color = '#6366f1'): KanbanColumn {
    const col: KanbanColumn = {
      id: this.genId('col'),
      title,
      color,
      taskIds: [],
    };
    this.board.columns.push(col);
    this.emit('kanban:column_added', col);
    this.emit('kanban:changed', this.board);
    return col;
  }

  updateColumn(id: string, patch: Partial<Pick<KanbanColumn, 'title' | 'color'>>): boolean {
    const col = this.board.columns.find((c) => c.id === id);
    if (!col) return false;
    Object.assign(col, patch);
    this.emit('kanban:column_updated', col);
    this.emit('kanban:changed', this.board);
    return true;
  }

  removeColumn(id: string, moveCardsToColumnId?: string): boolean {
    const idx = this.board.columns.findIndex((c) => c.id === id);
    if (idx === -1) return false;

    const col = this.board.columns[idx];
    if (moveCardsToColumnId) {
      const target = this.board.columns.find((c) => c.id === moveCardsToColumnId);
      if (target) target.taskIds.push(...col.taskIds);
    } else {
      // Remove all cards in this column
      this.board.cards = this.board.cards.filter((c) => !col.taskIds.includes(c.id));
    }

    this.board.columns.splice(idx, 1);
    this.emit('kanban:column_removed', { id });
    this.emit('kanban:changed', this.board);
    return true;
  }

  // ─── Card operations ──────────────────────────────────────────────────────

  addCard(
    columnId: string,
    title: string,
    description = '',
    priority: CardPriority = 'medium',
    tags: string[] = [],
  ): KanbanCard | null {
    const col = this.board.columns.find((c) => c.id === columnId);
    if (!col) return null;

    const card: KanbanCard = {
      id: this.genId('card'),
      title,
      description,
      columnId,
      tags,
      priority,
      createdAt: Date.now(),
    };

    this.board.cards.push(card);
    col.taskIds.push(card.id);
    this.emit('kanban:card_added', card);
    this.emit('kanban:changed', this.board);
    return card;
  }

  updateCard(id: string, patch: Partial<Omit<KanbanCard, 'id' | 'columnId' | 'createdAt'>>): boolean {
    const card = this.board.cards.find((c) => c.id === id);
    if (!card) return false;
    Object.assign(card, patch);
    this.emit('kanban:card_updated', card);
    this.emit('kanban:changed', this.board);
    return true;
  }

  removeCard(id: string): boolean {
    const card = this.board.cards.find((c) => c.id === id);
    if (!card) return false;

    const col = this.board.columns.find((c) => c.id === card.columnId);
    if (col) col.taskIds = col.taskIds.filter((tid) => tid !== id);
    this.board.cards = this.board.cards.filter((c) => c.id !== id);

    this.emit('kanban:card_removed', { id });
    this.emit('kanban:changed', this.board);
    return true;
  }

  /**
   * Move a card to a different column (or reorder within the same column).
   * toIndex = -1 appends to end.
   */
  moveCard(payload: MoveCardPayload): boolean {
    const { cardId, fromColumnId, toColumnId, toIndex } = payload;
    const fromCol = this.board.columns.find((c) => c.id === fromColumnId);
    const toCol = this.board.columns.find((c) => c.id === toColumnId);
    const card = this.board.cards.find((c) => c.id === cardId);

    if (!fromCol || !toCol || !card) return false;

    // Remove from source column
    fromCol.taskIds = fromCol.taskIds.filter((id) => id !== cardId);

    // Insert into target column at specified index
    if (toIndex < 0 || toIndex >= toCol.taskIds.length) {
      toCol.taskIds.push(cardId);
    } else {
      toCol.taskIds.splice(toIndex, 0, cardId);
    }

    // Update card's column reference
    card.columnId = toColumnId;

    this.emit('kanban:card_moved', payload);
    this.emit('kanban:changed', this.board);
    return true;
  }

  // ─── Agent task sync ──────────────────────────────────────────────────────

  /**
   * Sync an AgentTask to the board — creates or updates a card
   * and moves it to the appropriate column based on task status.
   */
  syncAgentTask(task: AgentTask, agentRunId: string): void {
    const statusColumnMap: Record<string, string> = {
      pending: 'backlog',
      in_progress: 'in_progress',
      completed: 'done',
      failed: 'failed',
      cancelled: 'cancelled',
    };

    const targetColumnId = statusColumnMap[task.status] ?? 'backlog';
    let card = this.board.cards.find((c) => c.id === task.id);

    if (!card) {
      const col = this.board.columns.find((c) => c.id === targetColumnId);
      if (!col) return;

      card = {
        id: task.id,
        title: task.title,
        description: task.description,
        columnId: targetColumnId,
        agentRunId,
        tags: task.toolCallsUsed,
        priority: 'medium',
        createdAt: task.createdAt,
        dueAt: undefined,
      };
      this.board.cards.push(card);
      col.taskIds.push(card.id);
    } else if (card.columnId !== targetColumnId) {
      this.moveCard({
        cardId: card.id,
        fromColumnId: card.columnId,
        toColumnId: targetColumnId,
        toIndex: -1,
      });
    }

    this.emit('kanban:changed', this.board);
  }

  // ─── Serialization ─────────────────────────────────────────────────────────

  toJSON(): string {
    return JSON.stringify(this.board, null, 2);
  }

  static fromJSON(json: string): KanbanBoard {
    return new KanbanBoard(JSON.parse(json) as KanbanBoardData);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private createDefaultBoard(partial?: Partial<KanbanBoardData>): KanbanBoardData {
    if (partial?.columns && partial.columns.length > 0) {
      return {
        id: partial.id ?? this.genId('board'),
        name: partial.name ?? 'Agent Tasks',
        columns: partial.columns,
        cards: partial.cards ?? [],
      };
    }

    // Default Kanban columns for agent task lifecycle
    const columns: KanbanColumn[] = [
      { id: 'backlog',     title: 'Backlog',      color: '#64748b', taskIds: [] },
      { id: 'in_progress', title: 'In Progress',  color: '#f59e0b', taskIds: [] },
      { id: 'done',        title: 'Done',         color: '#22c55e', taskIds: [] },
      { id: 'failed',      title: 'Failed',       color: '#ef4444', taskIds: [] },
      { id: 'cancelled',   title: 'Cancelled',    color: '#94a3b8', taskIds: [] },
    ];

    return {
      id: partial?.id ?? this.genId('board'),
      name: partial?.name ?? 'Agent Tasks',
      columns,
      cards: partial?.cards ?? [],
    };
  }

  private genId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }
}
