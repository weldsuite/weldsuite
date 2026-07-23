
/**
 * AWS WebSocket Notification Context and Provider
 * Provides real-time email notifications throughout the platform app
 * Uses AWS API Gateway WebSocket for serverless real-time communication
 */

import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from 'react';
import { useUser } from '@clerk/clerk-react';
import { AwsWebSocketClient } from '@/lib/notifications/aws-websocket-client';
import type {
  NotificationMessage,
  ConnectionStatus,
  NotificationHandler,
} from '@/lib/notifications/types';

interface NotificationContextValue {
  status: ConnectionStatus;
  notifications: NotificationMessage[];
  subscribe: (handler: NotificationHandler) => () => void;
  subscribeToType: (type: string, handler: NotificationHandler) => () => void;
  subscribeToEmailAccount: (accountId: string) => Promise<void>;
  unsubscribeFromEmailAccount: (accountId: string) => Promise<void>;
  clearNotifications: () => void;
}

const NotificationContext = createContext<NotificationContextValue | null>(
  null
);

// Get WebSocket URL from environment
const WEBSOCKET_URL = import.meta.env.VITE_EMAIL_WEBSOCKET_URL || '';
const MAX_STORED_NOTIFICATIONS = 100;

interface NotificationProviderProps {
  children: React.ReactNode;
}

export function NotificationProvider({ children }: NotificationProviderProps) {
  const { user } = useUser();
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [notifications, setNotifications] = useState<NotificationMessage[]>([]);
  const clientRef = useRef<AwsWebSocketClient | null>(null);

  // Initialize AWS WebSocket client
  useEffect(() => {
    if (!WEBSOCKET_URL) {
      console.warn('[NotificationProvider] NEXT_PUBLIC_EMAIL_WEBSOCKET_URL not configured');
      return;
    }

    if (!clientRef.current) {
      const client = new AwsWebSocketClient({
        endpoint: WEBSOCKET_URL,
      });

      // Subscribe to all notifications and store them
      client.subscribe((notification) => {
        setNotifications((prev) => {
          const updated = [...prev, notification];
          // Keep only the last N notifications
          return updated.slice(-MAX_STORED_NOTIFICATIONS);
        });
      });

      // Subscribe to status changes
      client.onStatusChange(setStatus);

      clientRef.current = client;
    }

    return () => {
      if (clientRef.current) {
        clientRef.current.destroy();
        clientRef.current = null;
      }
    };
  }, []);

  // Connect when user is available
  useEffect(() => {
    const connectWebSocket = async () => {
      if (!user?.id || !clientRef.current) return;

      try {
        await clientRef.current.connect(user.id);
      } catch (error) {
        console.error('[NotificationProvider] Failed to connect:', error);
      }
    };

    connectWebSocket();

    // Cleanup on unmount or user change
    return () => {
      if (clientRef.current) {
        clientRef.current.disconnect();
      }
    };
  }, [user?.id]);

  const subscribe = useCallback((handler: NotificationHandler) => {
    if (!clientRef.current) {
      console.warn('[NotificationProvider] Client not initialized');
      return () => {};
    }
    return clientRef.current.subscribe(handler);
  }, []);

  const subscribeToType = useCallback(
    (type: string, handler: NotificationHandler) => {
      if (!clientRef.current) {
        console.warn('[NotificationProvider] Client not initialized');
        return () => {};
      }
      return clientRef.current.subscribeToType(type, handler);
    },
    []
  );

  const subscribeToEmailAccount = useCallback(async (accountId: string) => {
    if (!clientRef.current) {
      console.warn('[NotificationProvider] Client not initialized');
      return;
    }
    await clientRef.current.subscribeToEmailAccount(accountId);
  }, []);

  const unsubscribeFromEmailAccount = useCallback(async (accountId: string) => {
    if (!clientRef.current) {
      console.warn('[NotificationProvider] Client not initialized');
      return;
    }
    await clientRef.current.unsubscribeFromEmailAccount(accountId);
  }, []);

  const clearNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  const value: NotificationContextValue = {
    status,
    notifications,
    subscribe,
    subscribeToType,
    subscribeToEmailAccount,
    unsubscribeFromEmailAccount,
    clearNotifications,
  };

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

/**
 * Hook to access notification context
 */
function useNotifications() {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error(
      'useNotifications must be used within a NotificationProvider'
    );
  }
  return context;
}
