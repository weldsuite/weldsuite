/**
 * AssignmentRouter Durable Object
 *
 * One per department. Single-threaded execution eliminates race conditions
 * in round-robin and least-busy assignment.
 *
 * Pattern from: Chatwoot's Redis FIFO queue, validated at scale.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env, AgentCapacity, AssignRequest } from '../types';

interface AssignmentState {
  departmentId: string;
  lastAssignedIndex: number;
  agents: AgentCapacity[];
}

export class AssignmentRouter extends DurableObject<Env> {

  // ─── Atomic assign: returns agent or null ───

  async assignConversation(request: AssignRequest): Promise<{
    agentId: string;
    userId: string;
    name: string;
  } | null> {
    const state = await this.loadState(request.departmentId);
    const eligible = this.getEligibleAgents(state, request.skills);

    if (eligible.length === 0) return null;

    let selected: AgentCapacity;

    if (request.mode === 'round_robin') {
      const nextIndex = (state.lastAssignedIndex + 1) % eligible.length;
      selected = eligible[nextIndex];
      state.lastAssignedIndex = nextIndex;
    } else {
      // least_busy: lowest currentActive
      selected = eligible.reduce((min, a) =>
        a.currentActive < min.currentActive ? a : min
      );
    }

    // Atomic increment — no race: single-threaded per department
    selected.currentActive++;

    // Update in main agents list too
    const agentInList = state.agents.find(a => a.agentId === selected.agentId);
    if (agentInList) agentInList.currentActive = selected.currentActive;

    await this.saveState(state);

    return {
      agentId: selected.agentId,
      userId: selected.userId,
      name: selected.name,
    };
  }

  // ─── Release: when conversation resolved/closed ───

  async releaseConversation(agentId: string): Promise<void> {
    const stored = await this.ctx.storage.get<AssignmentState>('state');
    if (!stored) return;

    const agent = stored.agents.find(a => a.agentId === agentId);
    if (agent && agent.currentActive > 0) {
      agent.currentActive--;
    }

    await this.ctx.storage.put('state', stored);
  }

  // ─── Sync agent roster ───

  async syncAgents(departmentId: string, agents: AgentCapacity[]): Promise<void> {
    const state = await this.loadState(departmentId);

    // Merge: keep currentActive from existing state if agent exists
    state.agents = agents.map(incoming => {
      const existing = state.agents.find(a => a.agentId === incoming.agentId);
      return {
        ...incoming,
        currentActive: existing?.currentActive ?? incoming.currentActive,
      };
    });

    await this.saveState(state);
  }

  // ─── Get current state (for debugging/monitoring) ───

  async getState(): Promise<AssignmentState | null> {
    return await this.ctx.storage.get<AssignmentState>('state') ?? null;
  }

  // ─── Private ───

  private getEligibleAgents(state: AssignmentState, skills?: string[]): AgentCapacity[] {
    return state.agents
      .filter(a => a.isAvailable && a.isOnline && a.currentActive < a.maxActive)
      .sort((a, b) => a.name.localeCompare(b.name)); // Stable sort for round-robin
  }

  private async loadState(departmentId: string): Promise<AssignmentState> {
    const stored = await this.ctx.storage.get<AssignmentState>('state');
    return stored ?? {
      departmentId,
      lastAssignedIndex: -1,
      agents: [],
    };
  }

  private async saveState(state: AssignmentState): Promise<void> {
    await this.ctx.storage.put('state', state);
  }
}
