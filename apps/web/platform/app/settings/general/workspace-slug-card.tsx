/**
 * Workspace identifier (slug) card.
 *
 * Renders on /settings/business. Shows the current workspace slug read-only
 * and lets the workspace OWNER change it from a confirmation dialog. The
 * dialog explicitly enumerates the public surfaces that break (booking,
 * helpcenter, weldmail) and requires the owner to retype the current slug
 * before the destructive action is enabled.
 *
 * Backed by app-api `POST /api/workspace-settings/slug` which keeps Clerk,
 * the master DB workspace row, helpcenter_domain_registry, and the tenant
 * helpcenter_settings row in sync (with rollback on Clerk sync failure).
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useOrganization } from '@clerk/clerk-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@weldsuite/ui/components/alert-dialog';
import { Button } from '@weldsuite/ui/components/button';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { useAppApi } from '@/lib/api/use-app-api';
import { useCurrentMember } from '@/hooks/use-current-member';
import { SLUG_REGEX } from '@weldsuite/app-api-client/schemas/workspace-settings';
import { useI18n } from '@/lib/i18n/provider';

function formatTemplate(
  tpl: string,
  vars: Record<string, string>,
): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

export function WorkspaceSlugCard() {
  const { t } = useI18n();
  const ts = t.settings.generalSettings.workspaceSlug;
  const { organization } = useOrganization();
  const { workspaceSettings } = useAppApi();
  const { data: member } = useCurrentMember();

  const isOwner = member?.role === 'OWNER';
  const currentSlug = organization?.slug ?? '';

  const [open, setOpen] = useState(false);
  const [newSlug, setNewSlug] = useState('');
  const [confirmSlug, setConfirmSlug] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const trimmedNew = newSlug.trim().toLowerCase();
  const isFormatValid = SLUG_REGEX.test(trimmedNew);
  const isDifferent = trimmedNew !== currentSlug;
  const isConfirmed = confirmSlug.trim() === currentSlug && currentSlug.length > 0;
  const canSubmit = isFormatValid && isDifferent && isConfirmed && !submitting;

  const handleOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setNewSlug('');
      setConfirmSlug('');
    }
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await workspaceSettings.updateSlug({ slug: trimmedNew });
      toast.success(ts.successToast);
      // Force a clean reload — the slug is part of public URLs (helpcenter,
      // booking) and several singletons cache the workspace object. A full
      // reload is the simplest safe reset and also picks up the new Clerk
      // org slug.
      await organization?.reload().catch(() => {});
      setTimeout(() => {
        window.location.reload();
      }, 600);
    } catch (err) {
      const message = err instanceof Error ? err.message : ts.errorToast;
      toast.error(message);
      setSubmitting(false);
    }
  };

  return (
    <div>
      <h3 className="text-lg font-semibold mb-1">{ts.title}</h3>
      <p className="text-sm text-muted-foreground mb-4">{ts.description}</p>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1.5 min-w-0 flex-1">
          <Label htmlFor="workspace-slug-current" className="text-xs text-muted-foreground">
            {ts.currentLabel}
          </Label>
          <Input
            id="workspace-slug-current"
            value={currentSlug}
            readOnly
            disabled
            className="font-mono"
          />
        </div>
        <div className="flex flex-col items-stretch sm:items-end gap-1">
          <Button
            variant="outline"
            onClick={() => setOpen(true)}
            disabled={!isOwner || !currentSlug}
          >
            {ts.changeButton}
          </Button>
          {!isOwner && (
            <p className="text-xs text-muted-foreground">{ts.ownerOnlyHint}</p>
          )}
        </div>
      </div>

      <AlertDialog open={open} onOpenChange={handleOpen}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              {ts.dialogTitle}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3 text-sm">
                <p className="font-medium text-foreground">{ts.warningHeading}</p>
                <p>{ts.warningIntro}</p>
                <ul className="list-disc pl-5 space-y-1.5 text-muted-foreground">
                  <li>{formatTemplate(ts.impactBookingPages, { currentSlug, newSlug: trimmedNew || '…' })}</li>
                  <li>{formatTemplate(ts.impactHelpcenter, { currentSlug, newSlug: trimmedNew || '…' })}</li>
                  <li>{formatTemplate(ts.impactWeldmail, { currentSlug, newSlug: trimmedNew || '…' })}</li>
                  <li>{ts.impactExternal}</li>
                </ul>
                <p>{formatTemplate(ts.warningOutro, { currentSlug })}</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="new-slug">{ts.newSlugLabel}</Label>
              <Input
                id="new-slug"
                autoComplete="off"
                spellCheck={false}
                placeholder={ts.newSlugPlaceholder}
                value={newSlug}
                onChange={(e) => setNewSlug(e.target.value.toLowerCase())}
                className="font-mono"
                disabled={submitting}
              />
              {newSlug.length > 0 && !isFormatValid && (
                <p className="text-xs text-destructive">{ts.invalidFormat}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="confirm-slug">
                {formatTemplate(ts.confirmLabel, { slug: currentSlug })}
              </Label>
              <Input
                id="confirm-slug"
                autoComplete="off"
                spellCheck={false}
                value={confirmSlug}
                onChange={(e) => setConfirmSlug(e.target.value)}
                className="font-mono"
                disabled={submitting}
              />
            </div>
          </div>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>{ts.cancelButton}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleSubmit();
              }}
              disabled={!canSubmit}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {ts.submitButton}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
