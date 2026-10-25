import { memo, type CSSProperties } from 'react';
import type { DisplayItem } from '@weldsuite/docs-engine';

/**
 * One page's drawing: every item absolutely placed in points, so the page
 * looks exactly as the layout measured it (text on its baseline at the x the
 * layout chose, whatever the browser's own line breaking would do).
 */
export const PageContent = memo(function PageContent({ items }: { items: DisplayItem[] }) {
  return (
    <>
      {items.map((item, i) => (
        <Item key={i} item={item} />
      ))}
    </>
  );
});

function Item({ item }: { item: DisplayItem }) {
  switch (item.kind) {
    case 'rect':
      return (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            left: `${item.x}pt`,
            top: `${item.y}pt`,
            width: `${item.width}pt`,
            height: `${item.height}pt`,
            background: item.fill,
            borderRadius: item.radius ? `${item.radius}pt` : undefined,
          }}
        />
      );
    case 'line':
      return <div aria-hidden style={lineStyle(item)} />;
    case 'image':
      return <ImageItem item={item} />;
    case 'checkbox':
      return (
        <div aria-hidden style={checkboxStyle(item)}>
          {item.checked ? '✓' : ''}
        </div>
      );
    case 'text':
      return <span style={textStyle(item)}>{item.text}</span>;
  }
}

function checkboxStyle(item: Extract<DisplayItem, { kind: 'checkbox' }>): CSSProperties {
  return {
    position: 'absolute',
    left: `${item.x}pt`,
    top: `${item.y}pt`,
    width: `${item.size}pt`,
    height: `${item.size}pt`,
    border: `1pt solid ${item.color}`,
    borderRadius: '2pt',
    background: item.checked ? item.color : 'transparent',
    color: '#ffffff',
    fontSize: `${item.size * 0.8}pt`,
    lineHeight: `${item.size}pt`,
    textAlign: 'center',
    cursor: 'pointer',
  };
}

function textStyle(item: Extract<DisplayItem, { kind: 'text' }>): CSSProperties {
  const s = item.style;
  // Suggested insertions are underlined in green, suggested deletions struck through in red.
  const kind = s.suggestion?.kind;
  const decorations = [s.underline || kind === 'insert' ? 'underline' : '', s.strike || kind === 'delete' ? 'line-through' : ''].filter(Boolean).join(' ');
  return {
    position: 'absolute',
    left: `${item.x}pt`,
    top: `${item.baseline - item.ascent}pt`,
    height: `${item.ascent + item.descent}pt`,
    lineHeight: `${item.ascent + item.descent}pt`,
    fontFamily: fontFamily(s.font.family),
    fontSize: `${s.font.size}pt`,
    fontWeight: s.font.bold ? 700 : 400,
    fontStyle: s.font.italic ? 'italic' : 'normal',
    color: SUGGESTION_COLORS[kind ?? ''] ?? s.color,
    whiteSpace: 'pre',
    textDecoration: decorations || undefined,
    wordSpacing: item.wordSpacing ? `${item.wordSpacing}pt` : undefined,
    letterSpacing: s.spacing ? `${s.spacing}pt` : undefined,
    fontKerning: 'normal',
  };
}

const SUGGESTION_COLORS: Record<string, string> = { insert: '#188038', delete: '#c5221f' };

function ImageItem({ item }: { item: Extract<DisplayItem, { kind: 'image' }> }) {
  const img = item.image;
  const style: CSSProperties = {
    position: 'absolute',
    left: `${item.x}pt`,
    top: `${item.y}pt`,
    width: `${item.width}pt`,
    height: `${item.height}pt`,
    objectFit: 'fill',
    border: img.border ? `${img.border.width}pt solid ${img.border.color}` : undefined,
  };
  // Drive images (file:<id>, from .docx imports) are resolved with the file import; others load as they are.
  if (img.src.startsWith('file:')) return <div aria-label={img.alt} style={{ ...style, background: '#f1f3f4' }} />;
  const c = img.crop;
  if (!c) return <img src={img.src} alt={img.alt ?? ''} draggable={false} style={style} />;
  // Cropped: the whole picture, scaled so the kept part fills the box, shown through it.
  const fullWidth = item.width / Math.max(0.01, 1 - c.left - c.right);
  const fullHeight = item.height / Math.max(0.01, 1 - c.top - c.bottom);
  return (
    <div style={{ ...style, overflow: 'hidden' }}>
      <img
        src={img.src}
        alt={img.alt ?? ''}
        draggable={false}
        style={{ position: 'absolute', left: `${-c.left * fullWidth}pt`, top: `${-c.top * fullHeight}pt`, width: `${fullWidth}pt`, height: `${fullHeight}pt`, maxWidth: 'none' }}
      />
    </div>
  );
}

function lineStyle(item: Extract<DisplayItem, { kind: 'line' }>): CSSProperties {
  const horizontal = Math.abs(item.y1 - item.y2) < Math.abs(item.x1 - item.x2);
  const style = item.style === 'double' ? 'double' : item.style ?? 'solid';
  if (horizontal) {
    return {
      position: 'absolute',
      left: `${Math.min(item.x1, item.x2)}pt`,
      top: `${item.y1 - item.width / 2}pt`,
      width: `${Math.abs(item.x2 - item.x1)}pt`,
      height: 0,
      borderTop: `${item.width}pt ${style} ${item.color}`,
    };
  }
  return {
    position: 'absolute',
    left: `${item.x1 - item.width / 2}pt`,
    top: `${Math.min(item.y1, item.y2)}pt`,
    width: 0,
    height: `${Math.abs(item.y2 - item.y1)}pt`,
    borderLeft: `${item.width}pt ${style} ${item.color}`,
  };
}

/** A CSS font-family list: the family (quoted unless it is one plain word), then sans-serif. */
function fontFamily(family: string): string {
  if (/^[a-z-]+$/i.test(family)) return `${family}, sans-serif`;
  return `"${family.replace(/["\\]/g, '')}", sans-serif`;
}
