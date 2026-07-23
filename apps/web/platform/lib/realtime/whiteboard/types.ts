export const PRESENCE_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#FF8C42', '#6C5CE7', '#A8E6CF', '#FFB3BA',
];

export interface WhiteboardPresence {
  id: string;
  sessionId?: string;
  name: string;
  avatar?: string;
  color: string;
  cursor?: { x: number; y: number };
  tool?: string;
  selectedElements?: string[];
  lastActivity: number;
}

interface CursorUpdate {
  userId: string;
  x: number;
  y: number;
  tool?: string;
}

interface SelectionUpdate {
  userId: string;
  elementIds: string[];
}

interface ElementChange {
  type: 'add' | 'update' | 'delete';
  element?: unknown;
  elementId?: string;
  changes?: Partial<unknown>;
  timestamp: number;
  userId: string;
}

export interface BatchChange {
  adds?: unknown[];
  updates?: Array<{ id: string; changes: Partial<unknown> }>;
  deletes?: string[];
  timestamp: number;
  userId: string;
}

type WhiteboardEventType =
  | 'element:add'
  | 'element:update'
  | 'element:delete'
  | 'element:batch'
  | 'cursor:move'
  | 'selection:change';
