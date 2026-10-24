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
        <div
          aria-hidden
          style={{
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
          }}
        >
          {item.checked ? '✓' : ''}
        </div>
      );
    case 'text': {
      const s = item.style;
      const decorations = [s.underline ? 'underline' : '', s.strike ? 'line-through' : ''].filter(Boolean).join(' ');
      const style: CSSProperties = {
        position: 'absolute',
        left: `${item.x}pt`,
        top: `${item.baseline - item.ascent}pt`,
        height: `${item.ascent + item.descent}pt`,
        lineHeight: `${item.ascent + item.descent}pt`,
        fontFamily: fontFamily(s.font.family),
        fontSize: `${s.font.size}pt`,
        fontWeight: s.font.bold ? 700 : 400,
        fontStyle: s.font.italic ? 'italic' : 'normal',
        color: s.suggestion?.kind === 'insert' ? '#188038' : s.color,
        whiteSpace: 'pre',
        textDecoration: decorations || undefined,
        wordSpacing: item.wordSpacing ? `${item.wordSpacing}pt` : undefined,
        letterSpacing: s.spacing ? `${s.spacing}pt` : undefined,
        fontKerning: 'normal',
      };
      return <span style={style}>{item.text}</span>;
    }
  }
}

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
  // Drive images (file:<id>) are resolved when images arrive (phase 5); others load as they are.
  if (img.src.startsWith('file:')) return <div aria-label={img.alt} style={{ ...style, background: '#f1f3f4' }} />;
  return <img src={img.src} alt={img.alt ?? ''} draggable={false} style={style} />;
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

function fontFamily(family: string): string {
  return `${/^[a-z-]+$/i.test(family) ? family : `"${family.replace(/["\\]/g, '')}"`}, sans-serif`;
}
