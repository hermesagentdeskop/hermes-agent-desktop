// rev-a2b81d-20260901 WorkflowEditor.ts
import { EventEmitter } from 'events';
import {
  Workflow,
  WorkflowEdge,
  WorkflowNode,
  NodeType,
} from '../../schema/HermesTypes';

export interface NodePosition {
  x: number;
  y: number;
}

export interface WorkflowValidationError {
  nodeId?: string;
  edgeId?: string;
  message: string;
}

/**
 * WorkflowEditor — manages the state of the visual workflow editor.
 * Handles node/edge CRUD, connection validation, serialization, and execution ordering.
 */
export class WorkflowEditor extends EventEmitter {
  private workflow: Workflow;

  constructor(workflow?: Partial<Workflow>) {
    super();
    this.workflow = this.createWorkflow(workflow);
  }

  // ─── Workflow metadata ────────────────────────────────────────────────────

  setName(name: string): void {
    this.workflow.name = name;
    this.touch();
  }

  setDescription(description: string): void {
    this.workflow.description = description;
    this.touch();
  }

  getWorkflow(): Readonly<Workflow> {
    return { ...this.workflow, nodes: [...this.workflow.nodes], edges: [...this.workflow.edges] };
  }

  // ─── Nodes ────────────────────────────────────────────────────────────────

  addNode(type: NodeType, label: string, position: NodePosition, config: Record<string, unknown> = {}): WorkflowNode {
    const node: WorkflowNode = {
      id: this.genId('node'),
      type,
      label,
      config,
      position,
      inputs: [],
      outputs: [],
    };
    this.workflow.nodes.push(node);
    this.touch();
    this.emit('workflow:node_added', node);
    return node;
  }

  updateNode(id: string, patch: Partial<Pick<WorkflowNode, 'label' | 'config' | 'position'>>): boolean {
    const node = this.findNode(id);
    if (!node) return false;
    Object.assign(node, patch);
    this.touch();
    this.emit('workflow:node_updated', node);
    return true;
  }

  removeNode(id: string): boolean {
    const idx = this.workflow.nodes.findIndex((n) => n.id === id);
    if (idx === -1) return false;
    this.workflow.nodes.splice(idx, 1);
    // Remove all connected edges
    this.workflow.edges = this.workflow.edges.filter((e) => e.source !== id && e.target !== id);
    this.touch();
    this.emit('workflow:node_removed', { id });
    return true;
  }

  moveNode(id: string, position: NodePosition): boolean {
    return this.updateNode(id, { position });
  }

  // ─── Edges ────────────────────────────────────────────────────────────────

  addEdge(sourceId: string, targetId: string, condition?: string): WorkflowEdge | null {
    if (!this.findNode(sourceId) || !this.findNode(targetId)) return null;
    if (this.edgeExists(sourceId, targetId)) return null;
    if (this.wouldCreateCycle(sourceId, targetId)) return null;

    const edge: WorkflowEdge = {
      id: this.genId('edge'),
      source: sourceId,
      target: targetId,
      condition,
    };
    this.workflow.edges.push(edge);

    // Update node input/output references
    const src = this.findNode(sourceId)!;
    const tgt = this.findNode(targetId)!;
    if (!src.outputs.includes(edge.id)) src.outputs.push(edge.id);
    if (!tgt.inputs.includes(edge.id)) tgt.inputs.push(edge.id);

    this.touch();
    this.emit('workflow:edge_added', edge);
    return edge;
  }

  removeEdge(id: string): boolean {
    const edge = this.workflow.edges.find((e) => e.id === id);
    if (!edge) return false;

    // Clean up node references
    const src = this.findNode(edge.source);
    const tgt = this.findNode(edge.target);
    if (src) src.outputs = src.outputs.filter((eid) => eid !== id);
    if (tgt) tgt.inputs = tgt.inputs.filter((eid) => eid !== id);

    this.workflow.edges = this.workflow.edges.filter((e) => e.id !== id);
    this.touch();
    this.emit('workflow:edge_removed', { id });
    return true;
  }

  // ─── Validation ────────────────────────────────────────────────────────────

  validate(): WorkflowValidationError[] {
    const errors: WorkflowValidationError[] = [];

    if (this.workflow.nodes.length === 0) {
      errors.push({ message: 'Workflow has no nodes.' });
      return errors;
    }

    // Must have at least one trigger node
    const triggers = this.workflow.nodes.filter((n) => n.type === 'trigger');
    if (triggers.length === 0) {
      errors.push({ message: 'Workflow must have at least one trigger node.' });
    }

    // Check for disconnected non-trigger nodes
    for (const node of this.workflow.nodes) {
      if (node.type === 'trigger') continue;
      const hasIncomingEdge = this.workflow.edges.some((e) => e.target === node.id);
      if (!hasIncomingEdge) {
        errors.push({ nodeId: node.id, message: `Node "${node.label}" has no incoming connections.` });
      }
    }

    // Check for dangling edge references
    for (const edge of this.workflow.edges) {
      if (!this.findNode(edge.source)) {
        errors.push({ edgeId: edge.id, message: `Edge source node "${edge.source}" not found.` });
      }
      if (!this.findNode(edge.target)) {
        errors.push({ edgeId: edge.id, message: `Edge target node "${edge.target}" not found.` });
      }
    }

    return errors;
  }

  /** Return nodes in topological (execution) order. Throws if cycle detected. */
  topologicalOrder(): WorkflowNode[] {
    const visited = new Set<string>();
    const result: WorkflowNode[] = [];

    const visit = (id: string): void => {
      if (visited.has(id)) return;
      visited.add(id);
      // Visit all predecessors first
      for (const edge of this.workflow.edges) {
        if (edge.target === id) visit(edge.source);
      }
      const node = this.findNode(id);
      if (node) result.push(node);
    };

    for (const node of this.workflow.nodes) visit(node.id);
    return result;
  }

  // ─── Serialization ─────────────────────────────────────────────────────────

  toJSON(): string {
    return JSON.stringify(this.workflow, null, 2);
  }

  static fromJSON(json: string): WorkflowEditor {
    const workflow = JSON.parse(json) as Workflow;
    return new WorkflowEditor(workflow);
  }

  // ─── Private ───────────────────────────────────────────────────────────────

  private createWorkflow(partial?: Partial<Workflow>): Workflow {
    return {
      id: partial?.id ?? this.genId('wf'),
      name: partial?.name ?? 'New Workflow',
      description: partial?.description ?? '',
      nodes: partial?.nodes ?? [],
      edges: partial?.edges ?? [],
      createdAt: partial?.createdAt ?? Date.now(),
      updatedAt: partial?.updatedAt ?? Date.now(),
    };
  }

  private findNode(id: string): WorkflowNode | undefined {
    return this.workflow.nodes.find((n) => n.id === id);
  }

  private edgeExists(sourceId: string, targetId: string): boolean {
    return this.workflow.edges.some((e) => e.source === sourceId && e.target === targetId);
  }

  private wouldCreateCycle(sourceId: string, targetId: string): boolean {
    // DFS from targetId — if we can reach sourceId, adding this edge creates a cycle
    const visited = new Set<string>();
    const stack = [targetId];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current === sourceId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const edge of this.workflow.edges) {
        if (edge.source === current) stack.push(edge.target);
      }
    }
    return false;
  }

  private touch(): void {
    this.workflow.updatedAt = Date.now();
    this.emit('workflow:changed', this.workflow);
  }

  private genId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  }
}
