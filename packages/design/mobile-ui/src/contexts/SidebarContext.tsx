import React, { createContext, useContext } from 'react';

interface SidebarContextType {
  isCollapsed: boolean;
  expand: () => void;
}

const SidebarContext = createContext<SidebarContextType | null>(null);

export function SidebarProvider({
  children,
  isCollapsed,
  expand
}: {
  children: React.ReactNode;
  isCollapsed: boolean;
  expand: () => void;
}) {
  return (
    <SidebarContext.Provider value={{ isCollapsed, expand }}>
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  return useContext(SidebarContext);
}
