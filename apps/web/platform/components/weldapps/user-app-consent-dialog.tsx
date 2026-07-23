
import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@weldsuite/ui/components/dialog';
import { Button } from '@weldsuite/ui/components/button';
import { useI18n } from '@/lib/i18n/provider';
import { formatScopeLabel } from '@/lib/apps/scope-labels';

interface UserAppConsentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appName: string;
  /** Scopes to list — `requestedScopes` for a fresh install, `pendingScopes` for an update. */
  scopes: string[];
  mode: 'install' | 'update';
  onConfirm: () => void | Promise<void>;
}

/**
 * Shared consent dialog for WeldApps scope approval. Used by the App Store's
 * "Custom apps" section (initial install + re-approving an updated version's
 * new scopes) and by the "My apps" developer UI's install-in-workspace
 * shortcut, so the copy and scope formatting stay identical everywhere a
 * member is asked to approve what a WeldApp can access.
 */
export function UserAppConsentDialog({
  open,
  onOpenChange,
  appName,
  scopes,
  mode,
  onConfirm,
}: UserAppConsentDialogProps) {
  const { t, format } = useI18n();
  const wa = t.weldapps;
  const scopeLabels = wa.scopes as unknown as Record<string, string>;
  const [pending, setPending] = useState(false);

  const handleConfirm = async () => {
    setPending(true);
    try {
      await onConfirm();
    } finally {
      setPending(false);
    }
  };

  const title = mode === 'install'
    ? format(wa.consent.installTitle, { name: appName })
    : format(wa.consent.updateTitle, { name: appName });
  const description = mode === 'install' ? wa.consent.installDescription : wa.consent.updateDescription;
  const confirmLabel = mode === 'install' ? wa.consent.approveAndInstall : wa.consent.approve;

  return (
    <Dialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <ul className="space-y-2 py-2">
          {scopes.map((scope) => (
            <li key={scope} className="flex items-center gap-2 text-sm text-foreground">
              <Check className="h-4 w-4 text-muted-foreground shrink-0" />
              <span>{formatScopeLabel(scopeLabels, scope)}</span>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>
            {wa.consent.cancel}
          </Button>
          <Button type="button" disabled={pending} onClick={handleConfirm}>
            {pending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
