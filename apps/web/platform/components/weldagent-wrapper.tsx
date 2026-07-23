
import { createContext, useContext, useState, ReactNode, useCallback, useEffect } from 'react';

export interface EntityContext {
  type: string; // 'call', 'contact', 'deal', etc.
  id: string;
  title?: string;
  customSystemPrompt?: string;
  data?: Record<string, any>;
  suggestedTools?: string[];
  /** Short chat-starter prompts shown as suggestion chips on the empty panel. */
  suggestedPrompts?: string[];
}

interface WeldAgentContextType {
  isOpen: boolean;
  toggle: () => void;
  entityContext: EntityContext | null;
  setEntityContext: (context: EntityContext | null) => void;
}

const WeldAgentContext = createContext<WeldAgentContextType | null>(null);

function useWeldAgent() {
  const context = useContext(WeldAgentContext);
  if (!context) {
    throw new Error('useWeldAgent must be used within WeldAgentProvider');
  }
  return context;
}

// Safe version that returns null instead of throwing when provider is missing
export function useWeldAgentSafe() {
  return useContext(WeldAgentContext);
}

export function WeldAgentProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [entityContext, setEntityContextState] = useState<EntityContext | null>(null);

  const toggle = () => setIsOpen(prev => !prev);

  const setEntityContext = useCallback((context: EntityContext | null) => {
    setEntityContextState(context);
  }, []);

  return (
    <WeldAgentContext.Provider value={{ isOpen, toggle, entityContext, setEntityContext }}>
      {children}
    </WeldAgentContext.Provider>
  );
}

/**
 * Publishes the current page's entity context to the WeldAgent panel so the
 * agent (and its tools) know what entity the user is viewing. Clears the
 * context on unmount. No-op when used outside a WeldAgentProvider (e.g. public
 * routes) so it's safe to call unconditionally from any page component.
 */
export function usePageAgentContext(context: EntityContext | null | undefined): void {
  const provider = useWeldAgentSafe();
  const setEntityContext = provider?.setEntityContext;
  const serialized = context ? JSON.stringify(context) : null;

  useEffect(() => {
    if (!setEntityContext) return;
    setEntityContext(serialized ? (JSON.parse(serialized) as EntityContext) : null);
    return () => setEntityContext(null);
  }, [setEntityContext, serialized]);
}
