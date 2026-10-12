import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Bold, Image as ImageIcon, Italic, Link, Loader2, RemoveFormatting, Underline } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Switch } from '@weldsuite/ui/components/switch';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { runEditorCommand } from '@weldsuite/ui/lib/editor-commands';
import type { MailSignatureRow } from '@weldsuite/app-api-client/domains/mail-signatures';
import type { CreateMailSignatureInput } from '@weldsuite/app-api-client';
import { useCreateMailSignature, useUpdateMailSignature } from '@/hooks/queries/use-mail-queries';
import { useI18n } from '@/lib/i18n/provider';
import { getTranslations } from '@/lib/i18n';
import { sanitizeSignatureHtml, userWrittenText } from '@/app/weldmail/lib/signature';

export interface SignatureAccountOption {
  id: string;
  email: string;
}

type Visibility = 'personal' | 'company';

const TOOL_BUTTON = 'h-7 w-7 text-muted-foreground hover:text-foreground';

const isBlankSignature = (html: string) => !userWrittenText(html) && !/<img\s/i.test(html);

/**
 * Creates or edits one signature. The body is a small rich-text editor: the
 * formatting a signature needs, plus links and images by URL (a logo hosted
 * on the company site); pasted HTML from a signature generator works too.
 */
export function SignatureEditorDialog({
  open,
  onOpenChange,
  signature,
  accounts,
  canManageShared,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The signature being edited; none to create one. */
  signature: MailSignatureRow | null;
  accounts: SignatureAccountOption[];
  /** May create shared signatures (and so may pick who can use this one). */
  canManageShared: boolean;
}>) {
  const { t } = useI18n();
  const ts = getTranslations('settings').weldmail.signatures;
  const createSignature = useCreateMailSignature();
  const updateSignature = useUpdateMailSignature();
  const isSaving = createSignature.isPending || updateSignature.isPending;

  const editorRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('personal');
  const [accountIds, setAccountIds] = useState<string[]>([]);
  const [isDefault, setIsDefault] = useState(false);
  const [includeInReplies, setIncludeInReplies] = useState(true);
  const [includeInForwards, setIncludeInForwards] = useState(true);

  // Load the form each time the dialog opens. The editor mounts with the dialog,
  // so its content is written once it is there.
  useEffect(() => {
    if (!open) return undefined;
    setName(signature?.name ?? '');
    setVisibility(signature && signature.type !== 'personal' ? 'company' : 'personal');
    setAccountIds(signature?.accountIds ?? []);
    setIsDefault(signature?.isDefault ?? false);
    setIncludeInReplies(signature?.includeInReplies ?? true);
    setIncludeInForwards(signature?.includeInForwards ?? true);
    const timer = setTimeout(() => {
      if (editorRef.current) editorRef.current.innerHTML = sanitizeSignatureHtml(signature?.content ?? '');
    }, 0);
    return () => clearTimeout(timer);
  }, [open, signature]);

  const command = (editorCommand: string, value?: string) => {
    editorRef.current?.focus();
    runEditorCommand(editorCommand, value);
  };

  const insertLink = () => {
    const url = globalThis.prompt(ts.linkPrompt, 'https://');
    if (url && url !== 'https://') command('createLink', url);
  };

  const insertImage = () => {
    const url = globalThis.prompt(ts.imagePrompt, 'https://');
    if (url && /^https?:\/\//i.test(url)) command('insertImage', url);
  };

  const toggleAccount = (id: string, checked: boolean) => {
    setAccountIds((prev) => (checked ? [...prev, id] : prev.filter((existing) => existing !== id)));
  };

  const handleSave = async () => {
    const content = sanitizeSignatureHtml(editorRef.current?.innerHTML ?? '').trim();
    if (!name.trim()) {
      toast.error(ts.messages.nameRequired);
      return;
    }
    if (isBlankSignature(content)) {
      toast.error(ts.messages.contentRequired);
      return;
    }
    const data: CreateMailSignatureInput = {
      name: name.trim(),
      content,
      type: visibility,
      // Only accounts the list still offers; an account removed since stays out.
      accountIds: accountIds.filter((id) => accounts.some((account) => account.id === id)),
      isDefault,
      includeInReplies,
      includeInForwards,
    };
    try {
      if (signature) {
        await updateSignature.mutateAsync({ id: signature.id, ...data });
        toast.success(ts.messages.updated);
      } else {
        await createSignature.mutateAsync(data);
        toast.success(ts.messages.created);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : ts.messages.saveFailed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{signature ? ts.editSignature : ts.newSignature}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor="signature-name">{ts.name}</Label>
            <Input
              id="signature-name"
              value={name}
              maxLength={255}
              placeholder={ts.namePlaceholder}
              onChange={(e) => setName(e.target.value)}
              data-testid="signature-name-input"
            />
          </div>

          <div className="space-y-1.5">
            <Label id="signature-content-label">{ts.content}</Label>
            <div className="rounded-md border border-input focus-within:ring-1 focus-within:ring-ring">
              <div className="flex items-center gap-0.5 border-b border-input px-1 py-1">
                <EditorButton title={t.mail.toolbar.bold} onClick={() => command('bold')} icon={Bold} />
                <EditorButton title={t.mail.toolbar.italic} onClick={() => command('italic')} icon={Italic} />
                <EditorButton title={t.mail.toolbar.underline} onClick={() => command('underline')} icon={Underline} />
                <div className="w-px h-4 bg-border mx-0.5" />
                <EditorButton title={ts.insertLink} onClick={insertLink} icon={Link} />
                <EditorButton title={ts.insertImage} onClick={insertImage} icon={ImageIcon} />
                <div className="w-px h-4 bg-border mx-0.5" />
                <EditorButton title={t.mail.toolbar.removeFormatting} onClick={() => command('removeFormat')} icon={RemoveFormatting} />
              </div>
              <div
                ref={editorRef}
                contentEditable
                role="textbox"
                aria-multiline="true"
                aria-labelledby="signature-content-label"
                tabIndex={0}
                suppressContentEditableWarning
                data-placeholder={ts.contentPlaceholder}
                data-testid="signature-content-editor"
                className="min-h-[140px] max-h-[320px] overflow-y-auto px-3 py-2 text-sm outline-none [&:empty:before]:content-[attr(data-placeholder)] [&:empty:before]:text-muted-foreground [&_img]:max-w-full [&_a]:text-primary [&_a]:underline"
                onPaste={(e) => {
                  // Keep pasted signatures (from a generator or another client), minus anything unsafe.
                  const html = e.clipboardData.getData('text/html');
                  if (!html) return;
                  e.preventDefault();
                  runEditorCommand('insertHTML', sanitizeSignatureHtml(html));
                }}
              />
            </div>
          </div>

          {canManageShared && (
            <div className="space-y-2">
              <Label>{ts.visibility}</Label>
              <RadioGroup value={visibility} onValueChange={(value) => setVisibility(value as Visibility)} className="flex flex-col gap-2 sm:flex-row sm:gap-6">
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="personal" id="signature-visibility-personal" />
                  <Label htmlFor="signature-visibility-personal" className="font-normal">{ts.visibilityPersonal}</Label>
                </div>
                <div className="flex items-center gap-2">
                  <RadioGroupItem value="company" id="signature-visibility-company" />
                  <Label htmlFor="signature-visibility-company" className="font-normal">{ts.visibilityCompany}</Label>
                </div>
              </RadioGroup>
            </div>
          )}

          {accounts.length > 1 && (
            <div className="space-y-2">
              <Label>{ts.accounts}</Label>
              <p className="text-xs text-muted-foreground">{ts.accountsHint}</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {accounts.map((account) => (
                  <div key={account.id} className="flex items-center gap-2 min-w-0">
                    <Checkbox
                      id={`signature-account-${account.id}`}
                      checked={accountIds.includes(account.id)}
                      onCheckedChange={(checked) => toggleAccount(account.id, checked === true)}
                    />
                    <Label htmlFor={`signature-account-${account.id}`} className="font-normal truncate">
                      {account.email}
                    </Label>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-3">
            <SwitchRow id="signature-default" label={ts.isDefault} checked={isDefault} onChange={setIsDefault} />
            <SwitchRow id="signature-replies" label={ts.includeInReplies} checked={includeInReplies} onChange={setIncludeInReplies} />
            <SwitchRow id="signature-forwards" label={ts.includeInForwards} checked={includeInForwards} onChange={setIncludeInForwards} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t.common.actions.cancel}
          </Button>
          <Button onClick={() => void handleSave()} disabled={isSaving} data-testid="signature-save-btn">
            {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t.common.actions.save}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditorButton({
  title,
  onClick,
  icon: Icon,
}: Readonly<{ title: string; onClick: () => void; icon: React.ComponentType<{ className?: string }> }>) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className={TOOL_BUTTON}
      title={title}
      aria-label={title}
      // Keep the editor's selection, so the command applies to it.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}

function SwitchRow({
  id,
  label,
  checked,
  onChange,
}: Readonly<{ id: string; label: string; checked: boolean; onChange: (checked: boolean) => void }>) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
      <Label htmlFor={id} className="font-normal">{label}</Label>
    </div>
  );
}
