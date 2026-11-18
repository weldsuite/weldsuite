import { useState } from 'react';
import { Pencil, Unlink } from 'lucide-react';
import { isCollapsed, isSafeLink } from '@weldsuite/docs-engine';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Popover, PopoverAnchor, PopoverContent } from '@weldsuite/ui/components/popover';
import { useI18n } from '@/lib/i18n/provider';
import type { DocController } from './model/doc-controller';
import { MENU_EDGE_GAP, WithTooltip } from './ui';

// The link pop-ups sit at the text, under the line, as in Google Docs: the
// text being linked stays in view (a dialog in the middle of the screen
// covered it).
//  - LinkEditor adds or changes a link: Insert link, Ctrl+K, Edit in the bubble.
//  - LinkBubble shows while the caret is on a link: its address (opens it), Edit and Remove.

/** Where a pop-up hangs from, in the page view's pixels: the caret's line. */
export interface TextAnchor {
  left: number;
  top: number;
  height: number;
}

function Anchor({ at }: Readonly<{ at: TextAnchor }>) {
  return (
    <PopoverAnchor asChild>
      <div aria-hidden className="pointer-events-none absolute w-px" style={{ left: at.left, top: at.top, height: at.height }} />
    </PopoverAnchor>
  );
}

/** A web address, email or phone number, made into a link target; null when it is none of those. */
export function normalizeLink(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  if (/^(https?:|mailto:|tel:)/i.test(v)) return v;
  if (v.startsWith('#')) return v;
  if (isEmailAddress(v)) return `mailto:${v}`;
  if (/^\+?[\d\s()-]{6,}$/.test(v)) return `tel:${v.replace(/\s/g, '')}`;
  if (looksLikeDomain(v)) return `https://${v}`;
  return null;
}

/** name@host.tld: one @, no spaces, and a dot inside the host. Plain string checks (no backtracking regex). */
function isEmailAddress(v: string): boolean {
  const at = v.indexOf('@');
  if (at <= 0 || v.includes('@', at + 1) || /\s/.test(v)) return false;
  const host = v.slice(at + 1);
  // A dot with at least one character on each side.
  return host.lastIndexOf('.', host.length - 2) >= 1;
}

/** Text that starts with something like example.com: a dot inside the first word, with two or more characters after it. */
function looksLikeDomain(v: string): boolean {
  const firstWord = v.split(/\s/, 1)[0] ?? '';
  return firstWord.lastIndexOf('.', firstWord.length - 3) >= 1;
}

/** A link's address as people read it: without the scheme. */
export function linkLabel(url: string): string {
  return url.replace(/^(https?:\/\/|mailto:|tel:)/i, '');
}

/** Add or change the link of the selection (or of the link the caret is on). */
export function LinkEditor({ controller, at, onClose }: Readonly<{ controller: DocController; at: TextAnchor; onClose: () => void }>) {
  const { t } = useI18n();
  const tl = t.welddocs.link;
  const existing = controller.link();
  const collapsed = isCollapsed(controller.selection);
  const [text, setText] = useState(existing?.text ?? '');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [error, setError] = useState(false);

  const apply = () => {
    const target = normalizeLink(url);
    if (!target) {
      setError(true);
      return;
    }
    controller.setLink(target, collapsed && !existing ? text || url : undefined);
    onClose();
  };

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <Anchor at={at} />
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={MENU_EDGE_GAP}
        className="w-96 p-3"
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          {collapsed && !existing && (
            <Input value={text} placeholder={tl.text} aria-label={tl.text} onChange={(e) => setText(e.target.value)} />
          )}
          <div className="flex items-center gap-2">
            <Input
              value={url}
              placeholder={tl.urlPlaceholder}
              aria-label={tl.url}
              aria-invalid={error || undefined}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(false);
              }}
            />
            <Button type="submit" className="shrink-0">
              {tl.apply}
            </Button>
          </div>
          {error && <p className="text-xs text-destructive">{tl.invalid}</p>}
        </form>
      </PopoverContent>
    </Popover>
  );
}

/** The link the caret is on: its address, Edit and (for someone who may edit) Remove. */
export function LinkBubble({
  controller,
  at,
  url,
  onDismiss,
}: Readonly<{
  controller: DocController;
  at: TextAnchor;
  url: string;
  onDismiss: () => void;
}>) {
  const { t } = useI18n();
  const te = t.welddocs.editor;
  const bookmark = url.startsWith('#');
  const label = linkLabel(url);
  let address = <span className="min-w-0 truncate px-2 text-sm text-muted-foreground">{label}</span>;
  if (bookmark) {
    address = (
      <button type="button" className="min-w-0 truncate px-2 text-left text-sm text-primary hover:underline" onClick={() => controller.goToAnchor(url.slice(1))}>
        {label}
      </button>
    );
  } else if (isSafeLink(url)) {
    address = (
      <a href={url} target="_blank" rel="noopener noreferrer" title={te.openLink} className="min-w-0 truncate px-2 text-sm text-primary hover:underline">
        {label}
      </a>
    );
  }

  return (
    <Popover open onOpenChange={(open) => !open && onDismiss()}>
      <Anchor at={at} />
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={6}
        collisionPadding={MENU_EDGE_GAP}
        className="flex w-auto max-w-sm items-center gap-0.5 p-1"
        // Typing goes on in the document: the bubble never takes focus.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
      >
        {address}
        {!controller.readOnly && (
          <>
            <WithTooltip label={te.editLink}>
              <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={te.editLink} onClick={() => controller.openDialog('link')}>
                <Pencil />
              </Button>
            </WithTooltip>
            <WithTooltip label={te.removeLink}>
              <Button variant="ghost" size="icon-sm" className="shrink-0" aria-label={te.removeLink} onClick={() => controller.removeLink()}>
                <Unlink />
              </Button>
            </WithTooltip>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
