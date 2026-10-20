/**
 * "Insert link" for the mail composers' contentEditable editors: a popover with
 * the URL, optional link text and Apply / Remove. With the cursor in an existing
 * link it edits that link instead of adding one.
 */
import { useId, useRef, useState } from 'react';
import { Link2, type LucideIcon } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { runEditorCommand } from '@weldsuite/ui/lib/editor-commands';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n/provider';
import { buildLinkHtml, normalizeLinkUrl } from '@/app/weldmail/lib/link-url';

/** The link around a node, when it is inside the editor. */
function enclosingLink(node: Node, editor: HTMLElement): HTMLAnchorElement | null {
  const element = node instanceof Element ? node : node.parentElement;
  const anchor = element?.closest('a') ?? null;
  return anchor && editor.contains(anchor) ? anchor : null;
}

/** What the editor's selection was when the popover opened. */
interface LinkTarget {
  range: Range | null;
  link: HTMLAnchorElement | null;
  selectedText: string;
}

function readLinkTarget(editor: HTMLElement): LinkTarget {
  const selection = window.getSelection();
  const live = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const range = live && editor.contains(live.commonAncestorContainer) ? live.cloneRange() : null;
  return {
    range,
    link: range ? enclosingLink(range.commonAncestorContainer, editor) : null,
    selectedText: range && !range.collapsed ? range.toString() : '',
  };
}

/** Puts the caret back in the editor: on the saved selection, else at the end. */
function restoreSelection(editor: HTMLElement, range: Range | null) {
  editor.focus();
  const selection = window.getSelection();
  if (!selection) return;
  const target = range ?? document.createRange();
  if (!range) {
    target.selectNodeContents(editor);
    target.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(target);
}

// Editors report changes through `input` events (autosave listens to them).
function notifyEditorChanged(editor: HTMLElement) {
  editor.dispatchEvent(new Event('input', { bubbles: true }));
}

export function ComposeLinkButton({
  editorRef,
  className,
  iconClassName,
  icon: Icon = Link2,
  side = 'top',
  testId,
}: Readonly<{
  editorRef: React.RefObject<HTMLElement | null>;
  className?: string;
  iconClassName?: string;
  icon?: LucideIcon;
  side?: 'top' | 'bottom';
  testId?: string;
}>) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [invalid, setInvalid] = useState(false);
  // Whether the cursor was in an existing link when the popover opened.
  const [editingLink, setEditingLink] = useState(false);
  const fieldId = useId();
  const targetRef = useRef<LinkTarget>({ range: null, link: null, selectedText: '' });

  const handleOpenChange = (next: boolean) => {
    if (next) {
      const editor = editorRef.current;
      const target = editor ? readLinkTarget(editor) : { range: null, link: null, selectedText: '' };
      targetRef.current = target;
      setUrl(target.link?.getAttribute('href') ?? '');
      setText(target.link ? (target.link.textContent ?? '') : target.selectedText);
      setInvalid(false);
      setEditingLink(target.link !== null);
    }
    setOpen(next);
  };

  const finish = (editor: HTMLElement) => {
    setOpen(false);
    editor.focus();
  };

  const handleApply = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const href = normalizeLinkUrl(url);
    if (!href) {
      setInvalid(true);
      return;
    }
    const { range, link, selectedText } = targetRef.current;
    const label = text.trim();

    if (link && editor.contains(link)) {
      link.setAttribute('href', href);
      if (label && label !== link.textContent) link.textContent = label;
      notifyEditorChanged(editor);
    } else {
      restoreSelection(editor, range);
      const keepsSelectedText = !!selectedText && (!label || label === selectedText);
      if (keepsSelectedText) runEditorCommand('createLink', href);
      else runEditorCommand('insertHTML', buildLinkHtml(href, label));
    }
    finish(editor);
  };

  const handleRemove = () => {
    const editor = editorRef.current;
    const { link } = targetRef.current;
    if (!editor || !link || !editor.contains(link)) return;
    const range = document.createRange();
    range.selectNodeContents(link);
    restoreSelection(editor, range);
    runEditorCommand('unlink');
    finish(editor);
  };

  const title = editingLink ? t.mail.toolbar.editLink : t.mail.toolbar.insertLink;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          // Keeps the caret (and the selected text) in the editor while the popover opens.
          onMouseDown={(e) => e.preventDefault()}
          className={className}
          title={t.mail.toolbar.insertLink}
          aria-label={t.mail.toolbar.insertLink}
          data-testid={testId}
        >
          <Icon className={cn('h-4 w-4', iconClassName)} />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side={side}
        className="w-72 p-3"
        onCloseAutoFocus={(e) => e.preventDefault()}
        // Keys typed here (Ctrl+Enter included) are not the composer's shortcuts.
        onKeyDown={(e) => e.stopPropagation()}
      >
        <form
          className="space-y-3"
          aria-label={title}
          onSubmit={(e) => {
            e.preventDefault();
            handleApply();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-url`} className="text-xs">
              {t.mail.toolbar.linkUrl}
            </Label>
            <Input
              id={`${fieldId}-url`}
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setInvalid(false);
              }}
              placeholder={t.mail.toolbar.linkUrlPlaceholder}
              aria-invalid={invalid}
              aria-describedby={invalid ? `${fieldId}-error` : undefined}
              autoComplete="off"
              data-testid={testId ? `${testId}-url` : undefined}
              className="h-8 text-sm"
            />
            {invalid && (
              <p id={`${fieldId}-error`} role="alert" className="text-xs text-destructive">
                {t.mail.toolbar.linkInvalid}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-text`} className="text-xs">
              {t.mail.toolbar.linkText}
            </Label>
            <Input
              id={`${fieldId}-text`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t.mail.toolbar.linkTextPlaceholder}
              autoComplete="off"
              data-testid={testId ? `${testId}-text` : undefined}
              className="h-8 text-sm"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            {editingLink ? (
              <Button type="button" variant="ghost" size="sm" onClick={handleRemove} className="text-destructive hover:text-destructive">
                {t.mail.toolbar.linkRemove}
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" size="sm" disabled={!url.trim()}>
              {t.mail.toolbar.linkApply}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}
