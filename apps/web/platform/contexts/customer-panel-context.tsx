
import * as React from 'react';
import { createContext, useContext, useState, useCallback, useEffect } from 'react';

interface CustomerPanelContextType {
  isOpen: boolean;
  email: string | null;
  name: string | null;
  customerId: string | null;
  setIsOpen: (open: boolean) => void;
  openPanel: (email: string, name?: string, customerId?: string) => void;
  closePanel: () => void;
}

const CustomerPanelContext = createContext<CustomerPanelContextType | null>(null);

export function CustomerPanelProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpenState] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [customerId, setCustomerId] = useState<string | null>(null);

  const setIsOpen = useCallback((open: boolean) => {
    setIsOpenState(open);
    if (!open) {
      setEmail(null);
      setName(null);
      setCustomerId(null);
    }
  }, []);

  const openPanel = useCallback((customerEmail: string, customerName?: string, customerIdParam?: string) => {
    setEmail(customerEmail);
    setName(customerName || null);
    setCustomerId(customerIdParam || null);
    setIsOpenState(true);
    window.dispatchEvent(new CustomEvent('close-weldagent'));
  }, []);

  const closePanel = useCallback(() => {
    setIsOpenState(false);
    setEmail(null);
    setName(null);
    setCustomerId(null);
  }, []);

  // Close this panel when WeldAgent opens
  useEffect(() => {
    const handler = () => {
      setIsOpenState(false);
      setEmail(null);
      setName(null);
      setCustomerId(null);
    };
    window.addEventListener('close-detail-panels', handler);
    return () => window.removeEventListener('close-detail-panels', handler);
  }, []);

  const value = React.useMemo(
    () => ({ isOpen, email, name, customerId, setIsOpen, openPanel, closePanel }),
    [isOpen, email, name, customerId, setIsOpen, openPanel, closePanel]
  );

  return (
    <CustomerPanelContext.Provider value={value}>
      {children}
    </CustomerPanelContext.Provider>
  );
}

export function useCustomerPanel() {
  const context = useContext(CustomerPanelContext);
  if (!context) {
    throw new Error('useCustomerPanel must be used within a CustomerPanelProvider');
  }
  return context;
}

export function useCustomerPanelOptional() {
  return useContext(CustomerPanelContext);
}
