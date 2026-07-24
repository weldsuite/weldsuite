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

export interface BatchChange {
  adds?: unknown[];
  updates?: Array<{ id: string; changes: Partial<unknown> }>;
  deletes?: string[];
  timestamp: number;
  userId: string;
}
