import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { WorkspaceClient, type WorkspaceClientConfig, type CursorStore } from '../client/workspace-client';

const WorkspaceClientContext = createContext<WorkspaceClient | null>(null);

interface RealtimeProviderProps extends WorkspaceClientConfig {
  children: React.ReactNode;
  /**
   * Optional persistent cursor store. When supplied, the WorkspaceClient
   * resumes from the last-seen `eventId` on (re)connect so missed events
   * are replayed instead of refetched.
   */
  cursorStore?: CursorStore;
}

/**
 * Provides a WorkspaceClient instance to the React tree.
 * Connects on mount, disconnects on unmount.
 *
 * Handles React Strict Mode: each effect cycle creates a fresh client
 * so the cleanup fully tears down the previous connection.
 */
export function RealtimeProvider({ url, getToken, cursorStore, children }: RealtimeProviderProps) {
  const [client, setClient] = useState<WorkspaceClient | null>(null);
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const cursorStoreRef = useRef(cursorStore);
  cursorStoreRef.current = cursorStore;

  useEffect(() => {
    const c = new WorkspaceClient({
      url,
      getToken: () => getTokenRef.current(),
      cursorStore: cursorStoreRef.current,
    });
    setClient(c);
    c.connect();

    return () => {
      c.disconnect();
      setClient(null);
    };
  }, [url]);

  return (
    <WorkspaceClientContext.Provider value={client}>
      {children}
    </WorkspaceClientContext.Provider>
  );
}

/**
 * Get the WorkspaceClient instance, or null if not yet connected.
 * Used internally by hooks that need to handle the initial render
 * before the effect creates the client.
 */
export function useWorkspaceClientMaybe(): WorkspaceClient | null {
  return useContext(WorkspaceClientContext);
}

/**
 * Get the WorkspaceClient instance from context.
 * Throws if used outside a RealtimeProvider.
 */
export function useWorkspaceClient(): WorkspaceClient {
  const client = useContext(WorkspaceClientContext);
  if (!client) {
    throw new Error('useWorkspaceClient must be used within a RealtimeProvider');
  }
  return client;
}
