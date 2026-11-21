/**
 * Shows a new storefront key's secret, once. The API returns the secret only
 * when a key is created or rotated and never again, so the dialog does not
 * close by accident: Escape, a click outside and the corner button are off,
 * and Done is the way out. The secret lives in the caller's state and is
 * dropped when the dialog closes.
 *
 * The copy button follows the Modern Web Guidance copy-button guide: it names
 * what it copies, stays enabled while it confirms, swaps its icon and says
 * "Copied" or "Copy failed" in a status region next to it (not inside it).
 */

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import type { ChannelKeySecret } from '@/hooks/queries/use-commerce-channels-queries';
import { getTranslations } from '@/lib/i18n';
import { fill } from '@/app/weldcommerce/lib/text';

type CopyState = 'idle' | 'copied' | 'failed';

/** Copies `text` and reports it; one place for the timer so repeated clicks restart it. */
function useCopy(text: string): { state: CopyState; message: string; copy: () => Promise<void> } {
  const t = getTranslations('commerce').channels.keys.secret;
  const [state, setState] = useState<CopyState>('idle');
  // The status region says the same thing twice in a row on a second click: VoiceOver skips an identical message.
  const [repeat, setRepeat] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const last = useRef<CopyState>('idle');

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    let next: CopyState = 'copied';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      next = 'failed';
    }
    const same = last.current === next;
    setRepeat((current) => (same ? !current : false));
    last.current = next;
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setState('idle');
      last.current = 'idle';
    }, 2000);
  };

  const base = { idle: '', copied: t.copied, failed: t.copyFailed }[state];
  // A repeated message gets a no-break space so VoiceOver announces it again.
  return { state, message: repeat && base ? `${base}\u00A0` : base, copy };
}

function SecretBox({ secret, label }: Readonly<{ secret: string; label: string }>) {
  const t = getTranslations('commerce').channels.keys.secret;
  const { state, message, copy } = useCopy(secret);
  const Icon = state === 'copied' ? Check : Copy;

  return (
    <div className="flex items-stretch gap-2">
      {/* A read-only field: focusable and selectable, and it wraps instead of being cut off. */}
      <textarea
        readOnly
        rows={2}
        value={secret}
        aria-label={label}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        onFocus={(event) => event.currentTarget.select()}
        data-testid="key-secret"
        className="min-w-0 flex-1 resize-none break-all rounded-md border bg-muted/40 px-3 py-2 font-mono text-[13px] leading-snug outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <span className="relative flex">
        <Button
          type="button"
          variant="outline"
          className="h-auto min-h-6 min-w-6 gap-1.5 px-3 shadow-none"
          aria-label={fill(t.copyLabel, { label })}
          onClick={() => void copy()}
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
          <span aria-hidden="true">{t.copy}</span>
        </Button>
        {/* The live region sits next to the button, not in it, and stays in the DOM so its text change is announced. */}
        <span role="status" className="sr-only">
          {message}
        </span>
      </span>
      {state !== 'idle' && (
        <span aria-hidden="true" className={state === 'failed' ? 'self-center text-xs text-destructive' : 'self-center text-xs text-muted-foreground'}>
          {state === 'copied' ? t.copied : t.copyFailed}
        </span>
      )}
    </div>
  );
}

export function SecretDialog({
  secret,
  rotated,
  onClose,
}: Readonly<{
  /** The key and its secret; null closes the dialog. */
  secret: ChannelKeySecret | null;
  /** The secret is a rotated key's replacement. */
  rotated?: boolean;
  onClose: () => void;
}>) {
  const t = getTranslations('commerce').channels.keys.secret;

  return (
    <Dialog open={secret !== null} onOpenChange={() => undefined}>
      <DialogContent
        showCloseButton={false}
        className="max-w-xl"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{rotated ? t.rotatedTitle : t.title}</DialogTitle>
          <DialogDescription>{secret ? fill(t.description, { name: secret.key.name }) : ''}</DialogDescription>
        </DialogHeader>
        <InfoBanner variant="warning">
          <strong className="block">{t.warningTitle}</strong>
          {t.warning}
        </InfoBanner>
        {secret && <SecretBox secret={secret.secret} label={secret.key.name} />}
        {secret && rotated && <p className="text-sm text-muted-foreground">{t.rotatedHint}</p>}
        <DialogFooter>
          <Button type="button" onClick={onClose}>
            {t.done}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
