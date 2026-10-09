import { useState, type ComponentProps } from 'react';
import { Landmark, Loader2, RefreshCw } from 'lucide-react';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { useBankFeedProviders } from '@/hooks/queries/use-weldbooks-bank-feeds-queries';
import type { BankFeedConnection, BankFeedLinkMode } from '@/lib/api/domains/weldbooks-bank-feeds';
import { ConnectBankDialog } from './connect-bank-dialog';
import { useFeedTexts } from './feed-texts';
import { repairRequest, useBankFeedConnect } from './use-bank-feed-connect';

export interface ConnectBankButtonProps {
  /** `create` links a new bank; `reauth` and `add_accounts` repair `connection`. */
  mode?: BankFeedLinkMode;
  connection?: BankFeedConnection;
  label?: string;
  variant?: ComponentProps<typeof Button>['variant'];
  size?: ComponentProps<typeof Button>['size'];
  className?: string;
  /** Bank account the user came from: offered to the first account without a suggested match. */
  defaultBankAccountId?: string;
  /** Where a redirect flow brings the user back to; defaults to the current page. */
  returnTo?: string;
  onLinked?: (connection: BankFeedConnection) => void;
}

export type ConnectBankLauncherOptions = Pick<
  ConnectBankButtonProps,
  'mode' | 'connection' | 'defaultBankAccountId' | 'returnTo' | 'onLinked'
>;

/**
 * The bank feed link flow without its button, for places that start it from
 * something else (an empty state's action). Render `elements` wherever the
 * hook is used: they are the provider picker and the link dialogs.
 */
export function useConnectBankLauncher({
  mode = 'create',
  connection,
  defaultBankAccountId,
  returnTo,
  onLinked,
}: Readonly<ConnectBankLauncherOptions> = {}) {
  const { can } = usePermissions();
  const providers = useBankFeedProviders();
  const flow = useBankFeedConnect({ defaultBankAccountId, returnTo, onLinked });
  const [pickerOpen, setPickerOpen] = useState(false);

  const allowed = can('banking:create');
  const country = providers.data?.country ?? '';
  const options = providers.data?.providers ?? [];
  const repair = mode !== 'create' && connection ? repairRequest(connection, mode, providers.data) : null;
  const repairs = mode !== 'create' && !!connection;

  /** A provider can link this entity's banks (or repair this connection). */
  const available = repairs ? !!repair : options.length > 0;
  const disabled = !allowed || flow.busy || providers.isLoading || providers.isError || !available;

  const start = () => {
    if (repairs) {
      if (repair) void flow.connect(repair);
      return;
    }
    const only = options.length === 1 ? options[0] : undefined;
    if (only && !only.requiresInstitution) {
      void flow.connect({ provider: only });
      return;
    }
    setPickerOpen(true);
  };

  const elements = (
    <>
      {!repairs ? (
        <ConnectBankDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          providers={options}
          country={country}
          onConnect={(selection) =>
            void flow.connect({
              provider: selection.provider,
              institution: selection.institution,
              psuType: selection.psuType,
            })
          }
        />
      ) : null}
      {flow.dialogs}
    </>
  );

  return {
    start,
    allowed,
    available,
    disabled,
    /** Still finding out which providers there are. */
    loading: providers.isLoading,
    busy: flow.busy,
    repairs,
    elements,
  };
}

/**
 * One button for every bank feed link. Which provider opens depends on the
 * entity's country and on what is configured: with one provider the link
 * starts at once, with several (or a bank to choose) a small dialog comes
 * first. Each provider then runs its own launcher, and all of them end in the
 * same account mapping step.
 */
export function ConnectBankButton({
  mode = 'create',
  connection,
  label,
  variant,
  size,
  className,
  defaultBankAccountId,
  returnTo,
  onLinked,
}: Readonly<ConnectBankButtonProps>) {
  const { t } = useFeedTexts();
  const launcher = useConnectBankLauncher({ mode, connection, defaultBankAccountId, returnTo, onLinked });

  if (!launcher.allowed) return null;

  const Icon = launcher.busy ? Loader2 : launcher.repairs ? RefreshCw : Landmark;
  const text = launcher.busy ? t.connecting : (label ?? t.connectBank);

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        className={className}
        disabled={launcher.disabled}
        onClick={launcher.start}
      >
        <Icon className={launcher.busy ? 'animate-spin' : undefined} aria-hidden="true" />
        {text}
      </Button>
      {launcher.elements}
    </>
  );
}
