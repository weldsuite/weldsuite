import { useState } from 'react';
import { AlertTriangle, Check, Copy, Eye, EyeOff, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { isApiError } from '@weldsuite/api-client';
import { Button } from '@weldsuite/ui/components/button';
import { Switch } from '@weldsuite/ui/components/switch';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { copyText } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n/provider';
import {
  useDeskWidgetIdentity,
  useDisableDeskWidgetIdentity,
  useRotateDeskWidgetIdentity,
  useUpdateDeskWidget,
} from '@/hooks/queries/use-desk-queries';

const SECRET_MASK = '•'.repeat(32);

const SERVER_SNIPPET = `import { SignJWT } from 'jose';

const token = await new SignJWT({ email: user.email, name: user.name })
  .setProtectedHeader({ alg: 'HS256' })
  .setSubject(String(user.id))
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(process.env.WELDDESK_IDENTITY_SECRET));`;

function browserSnippet(widgetId: string): string {
  return `const widget = HelpdeskWidget.initHelpdeskWidget({
  widgetId: '${widgetId}',
  auth: { identityToken: token },
});`;
}

const IDENTIFY_SNIPPET = 'widget.identify({ userId, email, name, identityToken: token });';
const LOGOUT_SNIPPET = 'widget.logout();';

function Snippet({ code, copyLabel }: Readonly<{ code: string; copyLabel: string }>) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative group">
      <pre className="bg-gray-50 dark:bg-background/50 border border-gray-200 dark:border-border rounded-lg p-3 pr-10 overflow-x-auto text-xs font-mono">
        <code className="text-gray-900 dark:text-foreground">{code}</code>
      </pre>
      <Button
        variant="ghost"
        size="sm"
        aria-label={copyLabel}
        title={copyLabel}
        onClick={() =>
          copyText(code, () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          })
        }
        className="absolute top-1.5 right-1.5 h-7 w-7 p-0"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
      </Button>
    </div>
  );
}

interface IdentityVerificationSectionProps {
  widgetId: string;
  /** From the widget row: known without fetching the secret. */
  identityRequired: boolean;
}

/**
 * Identity verification for one widget: the HS256 secret the customer's server
 * signs identity tokens with, and whether anonymous visitors are refused. The
 * secret is only fetched once the section is opened and only rendered when
 * revealed.
 */
export function IdentityVerificationSection({ widgetId, identityRequired }: Readonly<IdentityVerificationSectionProps>) {
  const { t } = useI18n();
  const ti = t.helpdesk.chatWidgetPage.identity;
  const [open, setOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [confirm, setConfirm] = useState<'rotate' | 'turnOff' | null>(null);

  const identity = useDeskWidgetIdentity(widgetId, open);
  const rotate = useRotateDeskWidgetIdentity();
  const disable = useDisableDeskWidgetIdentity();
  const updateWidget = useUpdateDeskWidget();

  const forbidden = isApiError(identity.error) && identity.error.status === 403;
  const secret = identity.data?.secret ?? null;
  const required = identity.data?.required ?? identityRequired;

  const close = () => {
    setOpen(false);
    setRevealed(false);
  };

  const handleRotate = async (firstTime: boolean) => {
    try {
      await rotate.mutateAsync(widgetId);
      toast.success(firstTime ? ti.setUpSuccess : ti.rotateSuccess);
      setConfirm(null);
    } catch {
      toast.error(ti.actionFailed);
    }
  };

  const handleTurnOff = async () => {
    try {
      await disable.mutateAsync(widgetId);
      setRevealed(false);
      toast.success(ti.turnOffSuccess);
      setConfirm(null);
    } catch {
      toast.error(ti.actionFailed);
    }
  };

  const handleRequiredChange = async (next: boolean) => {
    try {
      await updateWidget.mutateAsync({ widgetId, data: { identityRequired: next } });
      toast.success(next ? ti.requiredOn : ti.requiredOff);
    } catch {
      toast.error(ti.actionFailed);
    }
  };

  const renderBody = () => {
    if (!open) {
      return (
        <div className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            {identityRequired && <ShieldCheck className="h-4 w-4 flex-shrink-0 text-green-600" />}
            {identityRequired ? ti.statusRequired : ti.statusIdle}
          </p>
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            {ti.manage}
          </Button>
        </div>
      );
    }

    if (identity.isLoading) {
      return (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          {ti.loading}
        </p>
      );
    }

    if (forbidden) {
      return <p className="rounded-lg border px-4 py-3 text-sm text-muted-foreground">{ti.forbidden}</p>;
    }

    if (identity.isError) {
      return (
        <div className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
          <p className="text-sm text-muted-foreground">{ti.loadFailed}</p>
          <Button variant="outline" size="sm" onClick={() => void identity.refetch()}>
            {ti.retry}
          </Button>
        </div>
      );
    }

    if (!secret) {
      return (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border px-4 py-3">
          <div>
            <p className="text-sm font-medium">{ti.offTitle}</p>
            <p className="text-xs text-muted-foreground">{ti.offDescription}</p>
          </div>
          <Button size="sm" onClick={() => void handleRotate(true)} disabled={rotate.isPending}>
            {rotate.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {ti.setUp}
          </Button>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="space-y-2">
          <p id="widget-identity-secret-label" className="text-sm font-medium">{ti.secret}</p>
          <div className="flex flex-wrap items-center gap-2">
            <div
              aria-labelledby="widget-identity-secret-label"
              className="min-w-0 flex-1 truncate rounded-md border bg-gray-50 dark:bg-background/50 px-3 py-2 font-mono text-xs"
              data-testid="widget-identity-secret"
            >
              {revealed ? secret : SECRET_MASK}
            </div>
            <Button
              variant="outline"
              size="sm"
              aria-label={revealed ? ti.conceal : ti.reveal}
              title={revealed ? ti.conceal : ti.reveal}
              onClick={() => setRevealed((value) => !value)}
            >
              {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label={ti.copy}
              title={ti.copy}
              onClick={() => copyText(secret, () => toast.success(ti.copied))}
            >
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{ti.secretHint}</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setConfirm('rotate')} disabled={rotate.isPending}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {ti.rotate}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive"
              onClick={() => setConfirm('turnOff')}
              disabled={disable.isPending}
            >
              {ti.turnOff}
            </Button>
          </div>
        </div>

        <div className="rounded-lg border px-4 py-3 space-y-2">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">{ti.requiredLabel}</p>
              <p className="text-xs text-muted-foreground">{ti.requiredDescription}</p>
            </div>
            <Switch
              checked={required}
              onCheckedChange={(next) => void handleRequiredChange(next)}
              disabled={updateWidget.isPending}
              aria-label={ti.requiredLabel}
            />
          </div>
          <p className="flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
            {ti.requiredWarning}
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{ti.serverStep}</p>
          <Snippet code={SERVER_SNIPPET} copyLabel={ti.copyCode} />
          <p className="text-xs text-muted-foreground">{ti.claimsNote}</p>
          <p className="text-xs text-muted-foreground pt-2">{ti.browserStep}</p>
          <Snippet code={browserSnippet(widgetId)} copyLabel={ti.copyCode} />
          <p className="text-xs text-muted-foreground pt-2">{ti.identifyStep}</p>
          <Snippet code={IDENTIFY_SNIPPET} copyLabel={ti.copyCode} />
          <p className="text-xs text-muted-foreground pt-2">{ti.logoutStep}</p>
          <Snippet code={LOGOUT_SNIPPET} copyLabel={ti.copyCode} />
        </div>
      </div>
    );
  };

  return (
    <section className="space-y-4" data-testid="chat-widget-identity">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium">{ti.title}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{ti.description}</p>
        </div>
        {open && (
          <Button variant="ghost" size="sm" onClick={close}>
            {ti.close}
          </Button>
        )}
      </div>

      {renderBody()}

      <ConfirmDialog
        open={confirm === 'rotate'}
        onOpenChange={(next) => !next && setConfirm(null)}
        title={ti.rotateTitle}
        description={ti.rotateDescription}
        confirmLabel={ti.rotate}
        cancelLabel={t.common.actions.cancel}
        variant="destructive"
        onConfirm={() => handleRotate(false)}
      />
      <ConfirmDialog
        open={confirm === 'turnOff'}
        onOpenChange={(next) => !next && setConfirm(null)}
        title={ti.turnOffTitle}
        description={ti.turnOffDescription}
        confirmLabel={ti.turnOff}
        cancelLabel={t.common.actions.cancel}
        variant="destructive"
        onConfirm={handleTurnOff}
      />
    </section>
  );
}
