/**
 * Signatures in a compose editor: the hook that puts the default one in when a
 * mail is started, and the toolbar button to swap or remove it. Shared by the
 * compose surface (floating panel + full page) and the inline reply box.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, Settings2, Signature as SignatureIcon } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@weldsuite/ui/components/command';
import { useMailSignatures } from '@/hooks/queries/use-mail-queries';
import { useI18n } from '@/lib/i18n/provider';
import { useRouter } from '@/lib/router';
import { cn } from '@/lib/utils';
import {
  applySignature,
  currentSignatureId,
  pickDefaultSignature,
  signaturesForAccount,
  userWrittenText,
  type MailSignature,
  type SignatureMode,
} from '@/app/weldmail/lib/signature';

export const SIGNATURE_SETTINGS_HREF = '/settings/apps/weldmail?tab=signatures';

interface UseComposeSignatureOptions {
  editorRef: React.RefObject<HTMLDivElement | null>;
  accountId: string | undefined;
  /** Puts the default signature in once, for this kind of mail. Null: never on its own. */
  autoInsert: SignatureMode | null;
  /** Called after the user picked another signature, with the editor's new content. */
  onChange?: (html: string, text: string) => void;
  /**
   * One mail being written. The default goes in once per session; an editor
   * that stays mounted across mails (the inline reply box) passes a new value
   * for each one.
   */
  session?: string | null;
}

export function useComposeSignature({ editorRef, accountId, autoInsert, onChange, session }: UseComposeSignatureOptions) {
  const { data } = useMailSignatures();
  const loaded = data !== undefined;
  const signatures = signaturesForAccount(data?.data ?? [], accountId);

  // Once per session, when the signatures are in. Deferred a tick so the
  // caller's own setup (writing a handed-over body into the editor) has happened
  // first; a body that already holds text or a signature is left as it is.
  const defaultSignature = autoInsert ? pickDefaultSignature(signatures, accountId, autoInsert) : null;
  const defaultRef = useRef(defaultSignature);
  useEffect(() => {
    defaultRef.current = defaultSignature;
  });
  // The session the default was last considered for; null until the first one.
  const handledRef = useRef<{ session: string | null | undefined } | null>(null);
  useEffect(() => {
    if (!loaded || !autoInsert || (handledRef.current && handledRef.current.session === session)) return undefined;
    const timer = setTimeout(() => {
      const editor = editorRef.current;
      const signature = defaultRef.current;
      if (!editor) return;
      handledRef.current = { session };
      if (!signature || currentSignatureId(editor) || userWrittenText(editor.innerHTML)) return;
      applySignature(editor, signature);
    }, 0);
    return () => clearTimeout(timer);
  }, [loaded, autoInsert, session, editorRef]);

  const select = (signature: MailSignature | null) => {
    const editor = editorRef.current;
    if (!editor) return;
    applySignature(editor, signature);
    onChange?.(editor.innerHTML, editor.textContent ?? '');
  };

  return {
    signatures,
    select,
    getSelectedId: () => currentSignatureId(editorRef.current),
  };
}

/** The toolbar button: pick a signature, take it out, or go manage them. */
export function SignaturePicker({
  signatures,
  getSelectedId,
  onSelect,
  className,
  iconClassName,
  testId = 'compose-signature-btn',
}: Readonly<{
  signatures: MailSignature[];
  /** Read when the menu opens; the editor is the source of truth. */
  getSelectedId: () => string | null;
  onSelect: (signature: MailSignature | null) => void;
  className?: string;
  iconClassName?: string;
  testId?: string;
}>) {
  const { t } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (next) setSelectedId(getSelectedId());
    setOpen(next);
  };

  const choose = (signature: MailSignature | null) => {
    setOpen(false);
    onSelect(signature);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onMouseDown={(e) => e.preventDefault()}
          className={className}
          title={t.mail.toolbar.signature}
          aria-label={t.mail.toolbar.signature}
          data-testid={testId}
        >
          <SignatureIcon className={cn('h-4 w-4', iconClassName)} />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start" side="top" onCloseAutoFocus={(e) => e.preventDefault()}>
        <Command>
          <CommandList>
            <CommandGroup>
              {signatures.length === 0 && (
                <div className="px-2 py-1.5 text-sm text-muted-foreground">{t.mail.toolbar.noSignaturesYet}</div>
              )}
              {signatures.map((signature) => (
                <CommandItem key={signature.id} value={signature.id} onSelect={() => choose(signature)}>
                  <Check className={cn('h-4 w-4', selectedId === signature.id ? 'opacity-100' : 'opacity-0')} />
                  <span className="truncate">{signature.name}</span>
                </CommandItem>
              ))}
              {signatures.length > 0 && (
                <CommandItem value="__none" onSelect={() => choose(null)}>
                  <Check className={cn('h-4 w-4', selectedId === null ? 'opacity-100' : 'opacity-0')} />
                  {t.mail.toolbar.noSignature}
                </CommandItem>
              )}
            </CommandGroup>
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="__manage"
                onSelect={() => {
                  setOpen(false);
                  router.push(SIGNATURE_SETTINGS_HREF);
                }}
              >
                <Settings2 className="h-4 w-4" />
                {t.mail.toolbar.manageSignatures}
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
