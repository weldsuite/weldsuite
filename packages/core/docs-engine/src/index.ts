/**
 * @weldsuite/docs-engine: the WeldDocs word-processing engine.
 *
 * Pure TypeScript with no dependencies besides our own collab and zip/xml
 * packages, so the same code runs in the browser, in the DocRoom Durable
 * Object and in any worker that reads or writes documents. See
 * docs/plans/welddocs.md.
 */

export { LINE_BREAK, OBJECT, PARA, TAB, cleanStoryText, isStoryText, splitsSurrogate } from './model/chars';
export { Story } from './model/story';
export type { Attr, StoryPiece } from './model/story';
export { DocModel, SNAPSHOT_VERSION, emptyStory, sectionStoryIds } from './model/document';
export type { DocSnapshot } from './model/document';
export { contentToPiece, pieceToContent, textContent } from './model/content';
export type { Content, StoryContent } from './model/content';
export { ContentBuilder } from './model/builder';
export type { Fragment, TableCellInput } from './model/builder';
export { freshIds, newId } from './model/ids';
export * from './model/objects';
export * from './model/styles';
export {
  BUILT_IN_STYLES,
  DEFAULT_FONT,
  DEFAULT_SIZE,
  HEADING_STYLES,
  NORMAL,
  bulletList,
  checkList,
  numberedList,
} from './model/defaults';
export { outlineLevel, resolveParagraph, resolveText, styleChain } from './model/resolve';
export type { ResolvedText, StyleSource } from './model/resolve';
export { ListCounter, formatNumber, isOrdered } from './model/numbering';

export { applyOp } from './ops/apply';
export { mapDelete, mapInsert, transform, transformList } from './ops/transform';
export { NOOP, batch, isNoop, normalize, runsLength, unbatch } from './ops/types';
export type { FormatRun, Op, OpOf, OpType, SimpleOp } from './ops/types';
export { isWellFormedOp } from './ops/shape';
export { validateContent, validateOp } from './ops/validate';

export { createDocClient, createDocRoom, docsAdapter, restoreDocRoom } from './collab/adapter';
export type { DocClientOptions, DocPresence, DocRoomOptions, DocsAdapter } from './collab/adapter';

export { inlineText, toBlocks } from './serialize/blocks';
export type { Block, BlockTree, Inline, ParagraphBlock, TableBlock, TableCellBlock, WriteSource } from './serialize/blocks';
export { toPlainText } from './serialize/text';
export { escapeAttr, escapeHtml, toHtml, toHtmlDocument } from './serialize/html-write';
export type { HtmlOptions } from './serialize/html-write';
export { fromHtml } from './serialize/html-read';
export type { HtmlReadOptions } from './serialize/html-read';
export { parseHtml, decodeEntities } from './serialize/html-parse';
export type { HtmlElement, HtmlNode, HtmlText } from './serialize/html-parse';
export { toMarkdown } from './serialize/markdown-write';
export { fromMarkdown } from './serialize/markdown-read';
export type { MarkdownReadOptions } from './serialize/markdown-read';

export { DocLayout } from './layout/document-layout';
export type { DocLayoutOptions } from './layout/document-layout';
export { CachedMeasurer, CanvasMeasurer, MetricsMeasurer, cssFont, fontKey, isWide } from './layout/measure';
export type { FontMetrics, FontSpec, TextMeasurer } from './layout/measure';
export { caretRect, hitTest, lineBounds, selectionRects, xOfOffset } from './layout/geometry';
export type { Affinity, CaretRect, HitResult, SelectionRect } from './layout/geometry';
export { cellContentOffset, cellHeight } from './layout/table';
export { pageDisplay } from './layout/display';
export type { DisplayItem, DisplayOptions } from './layout/display';
export { canBreakBefore } from './layout/breaks';
export { displayText } from './layout/run-style';
export type {
  BlockLayout,
  CellLayout,
  LineLayout,
  PageArea,
  PageLayout,
  ParaEntry,
  ParagraphLayout,
  PlacedItem,
  RowLayout,
  RunLayout,
  RunStyle,
  TableLayout,
} from './layout/types';

export { nextGrapheme, nextWord, paragraphAt, wordAt } from './editing/boundaries';
export {
  allHave,
  caretAt,
  clearFormatting,
  commonParagraphStyle,
  deleteBackward,
  deleteForward,
  deleteSelection,
  formatParagraphs,
  formatText,
  indent,
  insertFragment,
  insertLineBreak,
  insertObject,
  insertText,
  isCollapsed,
  linkAt,
  paragraphProps,
  paragraphSpan,
  removeLink,
  replaceRange,
  resolvedParagraphAt,
  resolvedStyleAt,
  selectedParagraphs,
  selectionRange,
  setLink,
  splitParagraph,
  styleForInsert,
  toggleChecked,
  toggleList,
} from './editing/commands';
export type { DeleteUnit, DocSelection, Edit, ListKind } from './editing/commands';
export { countWords, findAll, queryPattern, replaceAll, replacementFor, storiesInOrder, textStats } from './editing/find';
export type { DocumentStats, FindOptions, Match } from './editing/find';

export { FrameAssembler, MAX_FRAME, decodeClient, decodeServer, encode, refusedBatchId, toFrames } from '@weldsuite/collab';
export type { DocClientMessage, DocCommittedOp, DocPeer, DocServerMessage } from './collab/adapter';
export { isWellFormedSnapshot } from './ops/snapshot-shape';
