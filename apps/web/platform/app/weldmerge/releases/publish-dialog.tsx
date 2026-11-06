import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@weldsuite/ui/components/select';
import type { MergeReleaseDto } from '@weldsuite/app-api-client/schemas/weldmerge-across';
import { usePublishMergeRelease } from '@/hooks/queries/use-weldmerge-across-queries';
import { useKnowledgeSpaces } from '@/hooks/queries/use-knowledge-queries';
import { useMailAccounts } from '@/hooks/queries/use-mail-queries';
import { useI18n } from '@/lib/i18n/provider';
import { buildPublishInput } from './publish-input';

/**
 * Publishes a release's notes to a WeldKnow space and/or by email. The two
 * destinations are independent; at least one has to be chosen.
 */
export function PublishReleaseDialog({
  open,
  onOpenChange,
  release,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; release: MergeReleaseDto }>) {
  const { t } = useI18n();
  const tp = t.weldmerge.across.releases.publish;
  const publish = usePublishMergeRelease();
  const spaces = useKnowledgeSpaces(open);
  const accounts = useMailAccounts(open);
  const spaceRows = spaces.data?.data ?? [];
  const accountRows = accounts.data?.data ?? [];

  const [toKnowledge, setToKnowledge] = useState(false);
  const [spaceId, setSpaceId] = useState('');
  const [toEmail, setToEmail] = useState(false);
  const [accountId, setAccountId] = useState('');
  const [recipients, setRecipients] = useState('');
  const [subject, setSubject] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setToKnowledge(false);
    setSpaceId('');
    setToEmail(false);
    setAccountId('');
    setRecipients('');
    setSubject(release.version ? `${release.name} ${release.version}` : release.name);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset when the dialog opens
  }, [open]);

  const submit = async () => {
    const built = buildPublishInput({ toKnowledge, spaceId, toEmail, accountId, recipients, subject }, release.notes);
    if ('problem' in built) return setError(tp[built.problem]);
    setError(null);
    try {
      const result = await publish.mutateAsync({ id: release.id, input: built.input });
      const parts = [result.knowledgePageId ? tp.publishedPage : null, result.emailSent ? tp.publishedEmail : null].filter(Boolean);
      toast.success(parts.length > 0 ? parts.join(' ') : tp.published);
      onOpenChange(false);
    } catch {
      toast.error(tp.failed);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tp.title}</DialogTitle>
          <DialogDescription>{tp.description}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox id="publish-knowledge" checked={toKnowledge} onCheckedChange={(v) => setToKnowledge(v === true)} />
              <Label htmlFor="publish-knowledge">{tp.toKnowledge}</Label>
            </div>
            {toKnowledge && (
              <div className="space-y-1.5 pl-6">
                <Label>{tp.space}</Label>
                <Select value={spaceId} onValueChange={setSpaceId}>
                  <SelectTrigger className="w-full" aria-label={tp.space}>
                    <SelectValue placeholder={tp.selectSpace} />
                  </SelectTrigger>
                  <SelectContent>
                    {spaceRows.map((space) => (
                      <SelectItem key={space.id} value={space.id}>
                        {space.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {spaces.isSuccess && spaceRows.length === 0 && <p className="text-xs text-muted-foreground">{tp.noSpaces}</p>}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Checkbox id="publish-email" checked={toEmail} onCheckedChange={(v) => setToEmail(v === true)} />
              <Label htmlFor="publish-email">{tp.toEmail}</Label>
            </div>
            {toEmail && (
              <div className="space-y-3 pl-6">
                <div className="space-y-1.5">
                  <Label>{tp.mailAccount}</Label>
                  <Select value={accountId} onValueChange={setAccountId}>
                    <SelectTrigger className="w-full" aria-label={tp.mailAccount}>
                      <SelectValue placeholder={tp.selectMailAccount} />
                    </SelectTrigger>
                    <SelectContent>
                      {accountRows.map((account) => (
                        <SelectItem key={account.id} value={account.id}>
                          {account.email}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {accounts.isSuccess && accountRows.length === 0 && (
                    <p className="text-xs text-muted-foreground">{tp.noMailAccounts}</p>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="publish-recipients">{tp.recipients}</Label>
                  <Input
                    id="publish-recipients"
                    value={recipients}
                    onChange={(event) => setRecipients(event.target.value)}
                    placeholder={tp.recipientsPlaceholder}
                  />
                  <p className="text-xs text-muted-foreground">{tp.recipientsHint}</p>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="publish-subject">{tp.subject}</Label>
                  <Input
                    id="publish-subject"
                    value={subject}
                    onChange={(event) => setSubject(event.target.value)}
                    placeholder={tp.subjectPlaceholder}
                  />
                </div>
              </div>
            )}
          </div>

          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t.common.actions.cancel}
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={publish.isPending}>
            {publish.isPending && <Loader2 className="animate-spin" />}
            {tp.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
