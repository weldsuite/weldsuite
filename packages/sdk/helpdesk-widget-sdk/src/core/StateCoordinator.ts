/**
 * Weld SDK - State Coordinator
 * Manages and synchronizes state across iframes
 */

import type {
  WeldState,
  StateAction,
  StateListener,
  StateSubscription,
} from '../types/state';
import {
  createInitialState,
  getStateValue,
  setStateValue,
} from '../types/state';
import type { MessageType } from '../types/messages';
import { Logger } from '../utils/logger';
import { MessageBroker } from './MessageBroker';
import { deepClone } from '../utils/validation';

/**
 * StateCoordinator class
 * Central state management for multi-iframe architecture
 */
export class StateCoordinator {
  private state: WeldState;
  private logger: Logger;
  private messageBroker: MessageBroker;
  private subscriptions: Map<string, StateSubscription> = new Map();
  private stateHistory: StateAction[] = [];
  private maxHistorySize = 50;

  constructor(messageBroker: MessageBroker, logger: Logger) {
    this.messageBroker = messageBroker;
    this.logger = logger.child('[StateCoordinator]');
    this.state = createInitialState();

    this.setupMessageHandlers();
    this.logger.debug('StateCoordinator initialized');
  }

  /**
   * Setup message handlers for state updates
   */
  private setupMessageHandlers(): void {
    // Listen for state update requests from iframes
    this.messageBroker.subscribe(
      'weld:state:update' as MessageType,
      this.handleStateUpdate.bind(this)
    );

    // Listen for state request messages
    this.messageBroker.subscribe(
      'weld:state:request' as MessageType,
      this.handleStateRequest.bind(this)
    );

    this.logger.debug('Message handlers setup');
  }

  /**
   * Handle state update from iframe
   */
  private handleStateUpdate(payload: any): void {
    const { path, value, merge } = payload;

    if (!path) {
      this.logger.warn('State update missing path', payload);
      return;
    }

    this.updateState(path, value, merge);
  }

  /**
   * Handle state request from iframe
   */
  private handleStateRequest(payload: any): void {
    const { path } = payload;

    if (path) {
      const value = getStateValue(this.state, path);
      this.messageBroker.broadcast('weld:state:response' as MessageType, {
        path,
        value,
      });
    } else {
      // Send entire state
      this.messageBroker.broadcast('weld:state:response' as MessageType, {
        state: this.state,
      });
    }
  }

  /**
   * Get current state
   */
  public getState(): WeldState {
    return deepClone(this.state);
  }

  /**
   * Get state value by path
   */
  public getValue<T = any>(path: string): T {
    return getStateValue(this.state, path);
  }

  /**
   * Update state
   */
  public updateState(path: string, value: any, merge = false): void {
    const oldState = deepClone(this.state);
    this.state = setStateValue(this.state, path, value, merge);

    // Create state action
    const action: StateAction = {
      type: 'UPDATE',
      path,
      payload: value,
      merge,
      timestamp: Date.now(),
    };

    // Add to history
    this.addToHistory(action);

    // Notify subscribers
    this.notifySubscribers(path, value, getStateValue(oldState, path));

    // Broadcast to iframes
    this.messageBroker.broadcast('weld:state:update' as MessageType, {
      path,
      value,
      merge,
    });

    this.logger.debug('State updated', { path, merge });
  }

  /**
   * Batch update multiple state paths
   */
  public batchUpdate(updates: Array<{ path: string; value: any; merge?: boolean }>): void {
    const oldState = deepClone(this.state);

    for (const update of updates) {
      this.state = setStateValue(
        this.state,
        update.path,
        update.value,
        update.merge
      );
    }

    // Notify subscribers for each update
    for (const update of updates) {
      this.notifySubscribers(
        update.path,
        getStateValue(this.state, update.path),
        getStateValue(oldState, update.path)
      );
    }

    // Broadcast all updates
    this.messageBroker.broadcast('weld:state:update' as MessageType, {
      batch: updates,
    });

    this.logger.debug('Batch state update', { count: updates.length });
  }

  /**
   * Reset state to initial
   */
  public resetState(): void {
    const oldState = this.state;
    this.state = createInitialState();

    // Notify all subscribers
    for (const [_id, subscription] of this.subscriptions) {
      const oldValue = getStateValue(oldState, subscription.path);
      const newValue = getStateValue(this.state, subscription.path);
      subscription.listener(newValue, oldValue);
    }

    // Broadcast reset
    this.messageBroker.broadcast('weld:state:update' as MessageType, {
      reset: true,
      state: this.state,
    });

    this.logger.debug('State reset');
  }

  /**
   * Subscribe to state changes
   */
  public subscribe<T = any>(
    path: string,
    listener: StateListener<T>,
    immediate = false
  ): string {
    const id = `sub_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    this.subscriptions.set(id, {
      id,
      path,
      listener,
      immediate,
    });

    // Call listener immediately if requested
    if (immediate) {
      const value = getStateValue(this.state, path);
      listener(value, value);
    }

    this.logger.debug('State subscription added', { id, path });
    return id;
  }

  /**
   * Unsubscribe from state changes
   */
  public unsubscribe(subscriptionId: string): void {
    if (this.subscriptions.delete(subscriptionId)) {
      this.logger.debug('State subscription removed', { id: subscriptionId });
    }
  }

  /**
   * Notify subscribers of state change
   */
  private notifySubscribers(path: string, newValue: any, oldValue: any): void {
    const subscriptions = Array.from(this.subscriptions.values());

    for (const subscription of subscriptions) {
      // Exact path match
      if (subscription.path === path) {
        try {
          subscription.listener(newValue, oldValue);
        } catch (error) {
          this.logger.error('Error in state listener', error);
        }
        continue;
      }

      // Parent path match (e.g., subscriber to "user" gets notified for "user.name")
      if (path.startsWith(subscription.path + '.')) {
        const subValue = getStateValue(this.state, subscription.path);
        try {
          subscription.listener(subValue, oldValue);
        } catch (error) {
          this.logger.error('Error in state listener', error);
        }
        continue;
      }

      // Child path match (e.g., subscriber to "user.name" gets notified for "user")
      if (subscription.path.startsWith(path + '.')) {
        const subValue = getStateValue(this.state, subscription.path);
        try {
          subscription.listener(subValue, undefined);
        } catch (error) {
          this.logger.error('Error in state listener', error);
        }
      }
    }
  }

  /**
   * Add action to history
   */
  private addToHistory(action: StateAction): void {
    this.stateHistory.push(action);

    // Trim history if too large
    if (this.stateHistory.length > this.maxHistorySize) {
      this.stateHistory.shift();
    }
  }

  /**
   * Get state history
   */
  public getHistory(): StateAction[] {
    return [...this.stateHistory];
  }

  /**
   * Clear state history
   */
  public clearHistory(): void {
    this.stateHistory = [];
    this.logger.debug('State history cleared');
  }

  /**
   * Get snapshot of state at specific time
   */
  public getSnapshot(timestamp: number): WeldState | null {
    // Find all actions before timestamp
    const actions = this.stateHistory.filter((a) => a.timestamp <= timestamp);

    if (actions.length === 0) {
      return null;
    }

    // Replay actions to reconstruct state
    let state = createInitialState();
    for (const action of actions) {
      state = setStateValue(state, action.path, action.payload, action.merge);
    }

    return state;
  }

  /**
   * Widget-specific state helpers
   */
  public openWidget(): void {
    this.batchUpdate([
      { path: 'widget.isOpen', value: true },
      { path: 'widget.visibility', value: 'visible' },
      { path: 'launcher.isVisible', value: false },
      { path: 'backdrop.isVisible', value: true },
    ]);
  }

  public closeWidget(): void {
    this.batchUpdate([
      { path: 'widget.isOpen', value: false },
      { path: 'widget.visibility', value: 'hidden' },
      { path: 'launcher.isVisible', value: true },
      { path: 'backdrop.isVisible', value: false },
    ]);
  }

  public minimizeWidget(): void {
    this.batchUpdate([
      { path: 'widget.isMinimized', value: true },
      { path: 'widget.visibility', value: 'minimized' },
    ]);
  }

  public maximizeWidget(): void {
    this.batchUpdate([
      { path: 'widget.isMinimized', value: false },
      { path: 'widget.visibility', value: 'visible' },
    ]);
  }

  public setBadgeCount(count: number): void {
    this.batchUpdate([
      { path: 'launcher.badge.count', value: count },
      { path: 'launcher.badge.show', value: count > 0 },
    ]);
  }

  public setUserAuth(userId: string, email?: string, name?: string): void {
    this.batchUpdate([
      { path: 'user.isAuthenticated', value: true },
      { path: 'user.isAnonymous', value: false },
      { path: 'user.id', value: userId },
      { path: 'user.email', value: email },
      { path: 'user.name', value: name },
    ]);
  }

  public setConnectionStatus(status: string): void {
    this.updateState('network.status', status);
  }

  public setLoading(isLoading: boolean): void {
    this.updateState('ui.isLoading', isLoading);
  }

  public setError(code: string, message: string, recoverable = true): void {
    this.updateState('ui.error', { code, message, recoverable });
  }

  public clearError(): void {
    this.updateState('ui.error', undefined);
  }

  /**
   * Get active subscription count
   */
  public getSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Validate state integrity
   */
  public validateState(): boolean {
    try {
      // Check required properties exist
      const requiredPaths = [
        'user',
        'conversation',
        'widget',
        'launcher',
        'backdrop',
        'mobile',
        'network',
        'ui',
      ];

      for (const path of requiredPaths) {
        if (getStateValue(this.state, path) === undefined) {
          this.logger.error('Missing required state path', { path });
          return false;
        }
      }

      return true;
    } catch (error) {
      this.logger.error('State validation failed', error);
      return false;
    }
  }

  /**
   * Export state as JSON
   */
  public exportState(): string {
    return JSON.stringify(this.state, null, 2);
  }

  /**
   * Import state from JSON
   */
  public importState(json: string): boolean {
    try {
      const imported = JSON.parse(json);
      this.state = { ...createInitialState(), ...imported };
      this.messageBroker.broadcast('weld:state:update' as MessageType, {
        reset: true,
        state: this.state,
      });
      this.logger.info('State imported');
      return true;
    } catch (error) {
      this.logger.error('Failed to import state', error);
      return false;
    }
  }

  /**
   * Destroy coordinator and cleanup
   */
  public destroy(): void {
    this.logger.debug('Destroying state coordinator');

    // Clear subscriptions
    this.subscriptions.clear();

    // Clear history
    this.stateHistory = [];

    // Reset state
    this.state = createInitialState();

    this.logger.info('StateCoordinator destroyed');
  }
}
