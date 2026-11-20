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
  /**
   * Reconnects when it changes, without remounting the children. The platform
   * passes the workspace id, so a workspace switch gets a socket for the new one.
   */
  connectionKey?: string;
  /**
   * The workspace the socket is for (`?workspace=`), on a server in
   * membership mode (OIDC `auth.workspaceSource: "header"`): the active
   * workspace's `workspaces.id`, the value the API calls send as
   * `X-Weld-Workspace`. `null` or unset on Clerk and claim-mode OIDC. A change
   * reconnects to the new workspace, like `connectionKey`.
   *
   *   <RealtimeProvider url={url} getToken={getToken} workspace={workspaceId ?? null}>
   */
  workspace?: string | null;
}

/**
 * Provides a WorkspaceClient instance to the React tree.
 * Connects on mount, disconnects on unmount.
 *
 * Handles React Strict Mode: each effect cycle creates a fresh client
 * so the cleanup fully tears down the previous connection.
 */
export function RealtimeProvider({
  url,
  getToken,
  cursorStore,
  connectionKey,
  workspace,
  children,
}: Readonly<RealtimeProviderProps>) {
  const [client, setClient] = useState<WorkspaceClient | null>(null);
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const cursorStoreRef = useRef(cursorStore);
  cursorStoreRef.current = cursorStore;
  // `undefined`, `null` and '' all name no workspace: one dependency value.
  const namedWorkspace = workspace || null;

  useEffect(() => {
    // No endpoint (realtime is off for this deployment): stay without a client.
    if (!url) return;
    const c = new WorkspaceClient({
      url,
      getToken: () => getTokenRef.current(),
      cursorStore: cursorStoreRef.current,
      workspace: namedWorkspace,
    });
    setClient(c);
    void c.connect();

    return () => {
      c.disconnect();
      setClient(null);
    };
  }, [url, connectionKey, namedWorkspace]);

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
