import { useEffect, useState } from 'react';
import { useWorkspaceClientMaybe } from './provider';
import type { ConnectionState } from '../types';

/**
 * Get the current workspace connection state.
 *
 * Usage:
 *   const { state, isConnected } = useRealtimeConnection();
 */
export function useRealtimeConnection(): {
  state: ConnectionState;
  isConnected: boolean;
} {
  const client = useWorkspaceClientMaybe();
  const [state, setState] = useState<ConnectionState>(client?.connectionState ?? 'disconnected');

  useEffect(() => {
    if (!client) {
      setState('disconnected');
      return;
    }
    setState(client.connectionState);
    return client.onConnectionChange(setState);
  }, [client]);

  return { state, isConnected: state === 'connected' };
}
