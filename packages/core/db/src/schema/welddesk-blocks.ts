/**
 * WeldDesk Interactive Message Blocks
 *
 * Block Kit-style component system for composing rich interactive messages.
 * Used by workflows, bots, and agents to send structured content.
 *
 * Shared across: helpdesk-widget, platform, api-worker, helpdesk-widget-api,
 * helpdesk-workflow-worker.
 */

// ============================================================================
// Block Definitions
// ============================================================================

interface BlockBase {
  id: string;
  type: string;
}

export interface TextBlock extends BlockBase {
  type: 'text';
  content: string;
  style?: 'default' | 'muted' | 'bold' | 'warning' | 'error';
}

export interface ButtonGroupBlock extends BlockBase {
  type: 'button_group';
  actionId: string;
  buttons: Array<{
    id: string;
    label: string;
    value: string;
    style?: 'primary' | 'secondary' | 'danger';
    icon?: string;
    url?: string;
  }>;
  layout?: 'horizontal' | 'vertical' | 'grid';
  maxSelections?: number;
}

export interface InputFormBlock extends BlockBase {
  type: 'input_form';
  actionId: string;
  fields: Array<{
    id: string;
    label: string;
    type: 'text' | 'email' | 'phone' | 'number' | 'textarea' | 'date' | 'select';
    placeholder?: string;
    required?: boolean;
    options?: Array<{ label: string; value: string }>;
    validation?: {
      pattern?: string;
      min?: number;
      max?: number;
      message?: string;
    };
  }>;
  submitLabel?: string;
}

export interface RatingBlock extends BlockBase {
  type: 'rating';
  actionId: string;
  style: 'stars' | 'emoji' | 'nps';
  question?: string;
  showFeedback?: boolean;
  feedbackLabel?: string;
}

export interface CardBlock extends BlockBase {
  type: 'card';
  title: string;
  description?: string;
  imageUrl?: string;
  imageAlt?: string;
  actions?: Array<{
    id: string;
    label: string;
    value: string;
    style?: 'primary' | 'secondary';
    url?: string;
  }>;
  actionId?: string;
  metadata?: Record<string, unknown>;
}

export interface CarouselBlock extends BlockBase {
  type: 'carousel';
  actionId?: string;
  cards: CardBlock[];
}

export interface ImageBlock extends BlockBase {
  type: 'image';
  url: string;
  alt?: string;
  caption?: string;
}

export interface DividerBlock extends BlockBase {
  type: 'divider';
}

export interface ContextBlock extends BlockBase {
  type: 'context';
  content: string;
}

export interface FileRequestBlock extends BlockBase {
  type: 'file_request';
  actionId: string;
  prompt?: string;
  accept?: string[];
  maxSize?: number;
  maxFiles?: number;
}

// ============================================================================
// Union Type
// ============================================================================

export type MessageBlock =
  | TextBlock
  | ButtonGroupBlock
  | InputFormBlock
  | RatingBlock
  | CardBlock
  | CarouselBlock
  | ImageBlock
  | DividerBlock
  | ContextBlock
  | FileRequestBlock;

// ============================================================================
// Response Tracking
// ============================================================================

export interface ButtonBlockResponse {
  actionId: string;
  type: 'button';
  value: { selectedIds: string[]; selectedValues: string[] };
  respondedAt: string;
  respondedBy?: string;
}

export interface FormBlockResponse {
  actionId: string;
  type: 'form';
  value: Record<string, string>;
  respondedAt: string;
  respondedBy?: string;
}

export interface RatingBlockResponse {
  actionId: string;
  type: 'rating';
  value: { rating: number; feedback?: string };
  respondedAt: string;
  respondedBy?: string;
}

export interface FileBlockResponse {
  actionId: string;
  type: 'file';
  value: {
    files: Array<{
      id: string;
      fileName: string;
      fileSize: number;
      mimeType: string;
      url: string;
    }>;
  };
  respondedAt: string;
  respondedBy?: string;
}

export type BlockResponse =
  | ButtonBlockResponse
  | FormBlockResponse
  | RatingBlockResponse
  | FileBlockResponse;

// ============================================================================
// Helpers
// ============================================================================

/** Check if a block has an actionId (is interactive) */
export function isInteractiveBlock(block: MessageBlock): block is MessageBlock & { actionId: string } {
  return 'actionId' in block && typeof (block as { actionId?: string }).actionId === 'string';
}

/** Get all actionIds from a message's blocks */
export function getActionIds(blocks: MessageBlock[]): string[] {
  return blocks
    .filter(isInteractiveBlock)
    .map((b) => (b as { actionId: string }).actionId);
}

/** Check if a specific action has been responded to */
export function isActionResponded(
  actionId: string,
  responses?: Record<string, BlockResponse> | null,
): boolean {
  return !!responses?.[actionId];
}

/** Check if all interactive blocks in a message have been responded to */
export function isFullyResponded(
  blocks: MessageBlock[],
  responses?: Record<string, BlockResponse> | null,
): boolean {
  const actionIds = getActionIds(blocks);
  if (actionIds.length === 0) return true;
  return actionIds.every((id) => isActionResponded(id, responses));
}
