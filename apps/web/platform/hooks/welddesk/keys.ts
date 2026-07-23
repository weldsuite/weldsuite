/** TanStack Query key factory for WeldDesk */
export const weldDeskKeys = {
  all: ['welddesk'] as const,
  conversation: (id: string) => [...weldDeskKeys.all, 'conversation', id] as const,
  messages: (id: string) => [...weldDeskKeys.all, 'messages', id] as const,
  events: (id: string) => [...weldDeskKeys.all, 'events', id] as const,
};
