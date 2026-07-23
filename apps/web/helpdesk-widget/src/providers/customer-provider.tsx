/**
 * CustomerProvider — Manages customer identity across the widget.
 *
 * Handles: customerId, visitorId, email, name, localStorage persistence.
 * Replaces scattered getCustomerProfile/saveCustomerProfile calls.
 */

import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import {
  getCustomerProfile,
  saveCustomerProfile,
  getOrCreateVisitorId,
  getOrCreateVisitorName,
} from '@/lib/utils/customer-storage';
import type { OpenContact } from '@/lib/api/types';

export interface CustomerState {
  customerId: string | null;
  visitorId: string;
  visitorName: string;
  email: string | null;
  name: string | null;
  contactId: string | null;
  setEmail: (email: string) => void;
  setName: (name: string) => void;
  setCustomerId: (id: string) => void;
  setContactId: (id: string) => void;
}

const CustomerContext = createContext<CustomerState | null>(null);

interface CustomerProviderProps {
  widgetId: string;
  initialEmail?: string;
  initialName?: string;
  contact?: OpenContact | null;
  children: React.ReactNode;
}

export function CustomerProvider({
  widgetId,
  initialEmail,
  initialName,
  contact,
  children,
}: CustomerProviderProps) {
  const visitorId = getOrCreateVisitorId();
  const visitorName = getOrCreateVisitorName();
  const profile = getCustomerProfile(widgetId);

  const [customerId, setCustomerIdState] = useState<string | null>(
    profile?.customerId || null,
  );
  const [email, setEmailState] = useState<string | null>(
    initialEmail || profile?.email || null,
  );
  const [name, setNameState] = useState<string | null>(
    initialName || profile?.name || null,
  );
  const [contactId, setContactIdState] = useState<string | null>(
    contact?.contactId || null,
  );

  const persist = useCallback(() => {
    saveCustomerProfile(widgetId, {
      customerId: customerId || undefined,
      visitorId,
      email: email || undefined,
      name: name || undefined,
    });
  }, [widgetId, customerId, visitorId, email, name]);

  const setEmail = useCallback((v: string) => { setEmailState(v); }, []);
  const setName = useCallback((v: string) => { setNameState(v); }, []);
  const setCustomerId = useCallback((v: string) => { setCustomerIdState(v); }, []);
  const setContactId = useCallback((v: string) => { setContactIdState(v); }, []);

  // Persist on change
  useEffect(() => { persist(); }, [persist]);

  return (
    <CustomerContext.Provider
      value={{
        customerId,
        visitorId,
        visitorName,
        email,
        name,
        contactId,
        setEmail,
        setName,
        setCustomerId,
        setContactId,
      }}
    >
      {children}
    </CustomerContext.Provider>
  );
}

export function useCustomer(): CustomerState {
  const ctx = useContext(CustomerContext);
  if (!ctx) throw new Error('useCustomer must be used within CustomerProvider');
  return ctx;
}
