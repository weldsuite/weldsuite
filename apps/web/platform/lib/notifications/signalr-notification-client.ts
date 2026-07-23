/**
 * SignalR Notification Client for Real-Time Notifications
 * Connects to WeldSuite.Api.Notifications SignalR hub
 * Supports workspace-scoped groups for multi-tenancy
 */

import * as signalR from '@microsoft/signalr';
import type { ConnectionStatus, NotificationHandler } from './types';

export interface UnifiedNotification {
  id: string;
  notificationType: string;
  category: string;
  title: string;
  body: string;
  entityType?: string;
  entityId?: string;
  actionUrl?: string;
  data?: Record<string, unknown>;
  createdAt: string;
}

interface SignalRNotificationClientConfig {
  hubUrl: string;
  getAccessToken?: () => Promise<string>;
  reconnectDelays?: number[];
}

class SignalRNotificationClient {
  private connection: signalR.HubConnection | null = null;
  private config: SignalRNotificationClientConfig;
  private currentWorkspaceId: string | null = null;
  private currentUserId: string | null = null;
  private listeners: Set<(notification: UnifiedNotification) => void> = new Set();
  private categoryListeners: Map<string, Set<(notification: UnifiedNotification) => void>> = new Map();
  private statusListeners: Set<(status: ConnectionStatus) => void> = new Set();
  private currentStatus: ConnectionStatus = 'disconnected';
  private subscribedEmailAccounts: Set<string> = new Set();

  constructor(config: SignalRNotificationClientConfig) {
    this.config = {
      hubUrl: config.hubUrl,
      getAccessToken: config.getAccessToken,
      reconnectDelays: config.reconnectDelays ?? [0, 2000, 5000, 10000, 30000],
    };
  }

  /**
   * Build the SignalR connection
   */
  private buildConnection(): signalR.HubConnection {
    const builder = new signalR.HubConnectionBuilder()
      .withUrl(this.config.hubUrl, {
        accessTokenFactory: this.config.getAccessToken,
        withCredentials: true,
      })
      .withAutomaticReconnect(this.config.reconnectDelays)
      .configureLogging(signalR.LogLevel.Information);

    return builder.build();
  }

  /**
   * Connect to the SignalR hub
   */
  async connect(workspaceId: string, userId: string): Promise<void> {
    if (this.connection?.state === signalR.HubConnectionState.Connected) {
      // If already connected to a different workspace, leave old and join new
      if (this.currentWorkspaceId && this.currentWorkspaceId !== workspaceId) {
        await this.leaveWorkspaceGroup();
      }
    }

    this.currentWorkspaceId = workspaceId;
    this.currentUserId = userId;
    this.updateStatus('connecting');

    try {
      if (!this.connection) {
        this.connection = this.buildConnection();
        this.setupConnectionHandlers();
      }

      if (this.connection.state !== signalR.HubConnectionState.Connected) {
        await this.connection.start();
      }

      // Join workspace-scoped group
      await this.connection.invoke('JoinWorkspaceGroup', workspaceId, userId);

      this.updateStatus('connected');

      // Re-subscribe to email accounts after connection
      for (const accountId of this.subscribedEmailAccounts) {
        await this.subscribeToEmailAccountInternal(accountId);
      }
    } catch (error) {
      console.error('[SignalR] Connection failed:', error);
      this.updateStatus('error');
      throw error;
    }
  }

  /**
   * Setup connection event handlers
   */
  private setupConnectionHandlers(): void {
    if (!this.connection) return;

    // Handle incoming notifications
    this.connection.on('ReceiveNotification', (notification: UnifiedNotification) => {
      this.handleNotification(notification);
    });

    // Handle reconnecting
    this.connection.onreconnecting(() => {
      this.updateStatus('connecting');
    });

    // Handle reconnected
    this.connection.onreconnected(async () => {
      this.updateStatus('connected');

      // Rejoin workspace group after reconnection
      if (this.currentWorkspaceId && this.currentUserId) {
        try {
          await this.connection?.invoke('JoinWorkspaceGroup', this.currentWorkspaceId, this.currentUserId);

          // Re-subscribe to email accounts
          for (const accountId of this.subscribedEmailAccounts) {
            await this.subscribeToEmailAccountInternal(accountId);
          }
        } catch (error) {
          console.error('[SignalR] Failed to rejoin workspace group:', error);
        }
      }
    });

    // Handle close
    this.connection.onclose((error) => {
      this.updateStatus('disconnected');
    });
  }

  /**
   * Handle incoming notification
   */
  private handleNotification(notification: UnifiedNotification): void {
    // Notify all general listeners
    this.listeners.forEach((listener) => {
      try {
        listener(notification);
      } catch (error) {
        console.error('[SignalR] Error in notification handler:', error);
      }
    });

    // Notify category-specific listeners
    if (notification.category) {
      const handlers = this.categoryListeners.get(notification.category);
      if (handlers) {
        handlers.forEach((handler) => {
          try {
            handler(notification);
          } catch (error) {
            console.error(`[SignalR] Error in ${notification.category} handler:`, error);
          }
        });
      }
    }
  }

  /**
   * Leave current workspace group
   */
  private async leaveWorkspaceGroup(): Promise<void> {
    if (this.connection?.state === signalR.HubConnectionState.Connected &&
        this.currentWorkspaceId && this.currentUserId) {
      try {
        await this.connection.invoke('LeaveWorkspaceGroup', this.currentWorkspaceId, this.currentUserId);
      } catch (error) {
        console.error('[SignalR] Failed to leave workspace group:', error);
      }
    }
  }

  /**
   * Disconnect from the hub
   */
  async disconnect(): Promise<void> {
    await this.leaveWorkspaceGroup();

    if (this.connection) {
      await this.connection.stop();
    }

    this.currentWorkspaceId = null;
    this.currentUserId = null;
    this.updateStatus('disconnected');
  }

  /**
   * Subscribe to all notifications
   */
  subscribe(handler: (notification: UnifiedNotification) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  /**
   * Subscribe to notifications for a specific category
   */
  subscribeToCategory(category: string, handler: (notification: UnifiedNotification) => void): () => void {
    if (!this.categoryListeners.has(category)) {
      this.categoryListeners.set(category, new Set());
    }
    this.categoryListeners.get(category)!.add(handler);

    return () => {
      const handlers = this.categoryListeners.get(category);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.categoryListeners.delete(category);
        }
      }
    };
  }

  /**
   * Subscribe to email account notifications
   */
  async subscribeToEmailAccount(emailAccountId: string): Promise<void> {
    this.subscribedEmailAccounts.add(emailAccountId);

    if (this.connection?.state === signalR.HubConnectionState.Connected) {
      await this.subscribeToEmailAccountInternal(emailAccountId);
    }
  }

  private async subscribeToEmailAccountInternal(emailAccountId: string): Promise<void> {
    try {
      await this.connection?.invoke('SubscribeToEmailAccount', emailAccountId);
    } catch (error) {
      console.error('[SignalR] Failed to subscribe to email account:', error);
    }
  }

  /**
   * Unsubscribe from email account notifications
   */
  async unsubscribeFromEmailAccount(emailAccountId: string): Promise<void> {
    this.subscribedEmailAccounts.delete(emailAccountId);

    if (this.connection?.state === signalR.HubConnectionState.Connected) {
      try {
        await this.connection.invoke('UnsubscribeFromEmailAccount', emailAccountId);
      } catch (error) {
        console.error('[SignalR] Failed to unsubscribe from email account:', error);
      }
    }
  }

  /**
   * Subscribe to connection status changes
   */
  onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
    this.statusListeners.add(listener);
    listener(this.currentStatus);
    return () => this.statusListeners.delete(listener);
  }

  /**
   * Get current connection status
   */
  getStatus(): ConnectionStatus {
    return this.currentStatus;
  }

  /**
   * Check if connected
   */
  isConnected(): boolean {
    return this.connection?.state === signalR.HubConnectionState.Connected;
  }

  /**
   * Get current workspace ID
   */
  getCurrentWorkspaceId(): string | null {
    return this.currentWorkspaceId;
  }

  private updateStatus(status: ConnectionStatus): void {
    if (this.currentStatus !== status) {
      this.currentStatus = status;
      this.statusListeners.forEach((listener) => {
        try {
          listener(status);
        } catch (error) {
          console.error('[SignalR] Error in status listener:', error);
        }
      });
    }
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    this.disconnect();
    this.listeners.clear();
    this.categoryListeners.clear();
    this.statusListeners.clear();
    this.subscribedEmailAccounts.clear();
    this.connection = null;
  }
}
