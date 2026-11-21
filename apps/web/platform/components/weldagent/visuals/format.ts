/**
 * Number formatting for chat visuals, in the reader's locale: shared with the
 * mobile apps (`@weldsuite/app-api-client/schemas/chat-visuals`). A spec says
 * how a number reads (`format`), never how it is spelled.
 */

export {
  compareVisualCells as compareCells,
  formatVisualChange as formatChange,
  formatVisualNumber as formatNumber,
  formatVisualValue as formatValue,
} from '@weldsuite/app-api-client/schemas/chat-visuals';
