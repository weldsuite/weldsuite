/**
 * Manage one connected phone system: connection details, settings (name,
 * phone system, transport, IP addresses), numbers with caller id verification,
 * a new password, switching it off and deleting it.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { ConfirmDialog } from '@weldsuite/ui/components/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { DESK_SIP_TRUNK_PROVIDERS, DESK_SIP_TRUNK_TRANSPORTS, type DeskSipTrunk } from '@weldsuite/core-api-client/schemas/desk-sip-trunks';
import { getTranslations } from '@/lib/i18n';
import {
  useDeleteDeskSipTrunk,
  useRotateDeskSipTrunkPassword,
  useUpdateDeskSipTrunk,
} from '@/hooks/queries/use-desk-sip-trunk-queries';
import { SipConnectionDetails } from './sip-connection-details';
import { SipIpListEditor } from './sip-ip-list-editor';
import { SipTrunkNumbers } from './sip-trunk-numbers';
import {
  ipRowsOf,
  ipRowsToInput,
  validateIpRows,
  type SipFormError,
  type SipIpRow,
  type SipProvider,
  type SipTransport,
} from './sip-trunk-form';

export interface ManageSipTrunkDialogProps {
  /** The trunk being managed; null while the dialog is closed. */
  trunk: DeskSipTrunk | null;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
}

export function ManageSipTrunkDialog({ trunk, onOpenChange, canEdit }: Readonly<ManageSipTrunkDialogProps>) {
  const t = getTranslations('deskSipTrunks');
  const m = t.manage;
  const [name, setName] = useState('');
  const [provider, setProvider] = useState<SipProvider>('other');
  const [transport, setTransport] = useState<SipTransport>('udp');
  const [ips, setIps] = useState<SipIpRow[]>([]);
  const [errors, setErrors] = useState<SipFormError[]>([]);
  const [password, setPassword] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<'rotate' | 'disable' | 'delete' | null>(null);
  const update = useUpdateDeskSipTrunk();
  const rotate = useRotateDeskSipTrunkPassword();
  const remove = useDeleteDeskSipTrunk();

  // Start from the trunk as it is each time one is opened (or changed under us).
  const trunkId = trunk?.id;
  const trunkUpdatedAt = trunk?.updatedAt;
  useEffect(() => {
    if (!trunk) return;
    setName(trunk.name);
    setProvider(trunk.provider);
    setTransport(trunk.transport);
    setIps(ipRowsOf(trunk.ipAddresses));
    setErrors([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset on the trunk's identity and last change only
  }, [trunkId, trunkUpdatedAt]);
  useEffect(() => setPassword(null), [trunkId]);

  if (!trunk) return null;
  const isIp = trunk.authMode === 'ip';

  const save = async () => {
    const found = isIp ? validateIpRows(ips, true) : [];
    setErrors(found);
    if (name.trim() === '' || found.length > 0) return;
    try {
      await update.mutateAsync({
        id: trunk.id,
        input: {
          name: name.trim(),
          provider,
          ...(isIp ? { transport, ipAddresses: ipRowsToInput(ips) } : {}),
        },
      });
      toast.success(m.saved);
    } catch {
      toast.error(m.saveFailed);
    }
  };

  const setStatus = async (status: 'active' | 'disabled') => {
    try {
      await update.mutateAsync({ id: trunk.id, input: { status } });
      toast.success(status === 'active' ? m.enabledToast : m.disabledToast);
    } catch {
      toast.error(m.saveFailed);
    }
  };

  const newPassword = async () => {
    try {
      const credentials = await rotate.mutateAsync(trunk.id);
      setPassword(credentials.password);
      toast.success(m.rotated);
    } catch {
      toast.error(m.rotateFailed);
    }
    setConfirm(null);
  };

  const deleteTrunk = async () => {
    try {
      await remove.mutateAsync(trunk.id);
      toast.success(m.deleted);
      setConfirm(null);
      onOpenChange(false);
    } catch {
      toast.error(m.deleteFailed);
      setConfirm(null);
    }
  };

  return (
    <>
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="manage-sip-trunk">
          <DialogHeader>
            <DialogTitle>{m.title.replace('{name}', trunk.name)}</DialogTitle>
            <DialogDescription>{m.description}</DialogDescription>
          </DialogHeader>

          <div className="space-y-6">
            {trunk.lastError && (
              <InfoBanner variant="warning" title={m.lastErrorTitle}>
                <span data-testid="sip-last-error">{trunk.lastError}</span>
              </InfoBanner>
            )}

            <section className="space-y-3">
              <h3 className="font-medium">{m.connection}</h3>
              <SipConnectionDetails
                connection={trunk.connection}
                authMode={trunk.authMode}
                ipAddresses={trunk.ipAddresses}
                password={password}
              />
              {!isIp && canEdit && (
                <Button type="button" variant="outline" size="sm" onClick={() => setConfirm('rotate')}>
                  {m.rotate}
                </Button>
              )}
            </section>

            <section className="space-y-3">
              <h3 className="font-medium">{t.numbers.title}</h3>
              <SipTrunkNumbers trunkId={trunk.id} numbers={trunk.numbers} canEdit={canEdit} />
            </section>

            <section className="space-y-3">
              <h3 className="font-medium">{m.settings}</h3>
              <div className="space-y-1.5">
                <Label htmlFor="sip-manage-name">{m.name}</Label>
                <Input id="sip-manage-name" value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} />
                {name.trim() === '' && <InlineError>{t.wizard.errors.nameRequired}</InlineError>}
              </div>
              <div className="space-y-2">
                <Label>{m.provider}</Label>
                <RadioGroup
                  value={provider}
                  onValueChange={(value) => setProvider(value as SipProvider)}
                  className="grid-cols-1 sm:grid-cols-3"
                  disabled={!canEdit}
                >
                  {DESK_SIP_TRUNK_PROVIDERS.map((value) => (
                    <div key={value} className="flex items-center gap-2">
                      <RadioGroupItem value={value} id={`sip-manage-provider-${value}`} />
                      <Label htmlFor={`sip-manage-provider-${value}`}>{t.providers[value]}</Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>
              {isIp && (
                <>
                  <div className="space-y-2">
                    <Label>{m.transport}</Label>
                    <RadioGroup
                      value={transport}
                      onValueChange={(value) => setTransport(value as SipTransport)}
                      className="grid-cols-1 sm:grid-cols-3"
                      disabled={!canEdit}
                    >
                      {DESK_SIP_TRUNK_TRANSPORTS.map((value) => (
                        <div key={value} className="flex items-center gap-2">
                          <RadioGroupItem value={value} id={`sip-manage-transport-${value}`} />
                          <Label htmlFor={`sip-manage-transport-${value}`}>{t.transports[value]}</Label>
                        </div>
                      ))}
                    </RadioGroup>
                  </div>
                  <div className="space-y-1.5">
                    <Label>{m.ipAddresses}</Label>
                    <SipIpListEditor rows={ips} onChange={setIps} errors={errors} disabled={!canEdit} />
                  </div>
                </>
              )}
              {canEdit && (
                <Button type="button" onClick={() => void save()} disabled={update.isPending || name.trim() === ''}>
                  {update.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {update.isPending ? m.saving : m.save}
                </Button>
              )}
            </section>
          </div>

          {canEdit && (
            <DialogFooter className="gap-2 sm:justify-between">
              <Button type="button" variant="destructive" onClick={() => setConfirm('delete')}>
                {m.delete}
              </Button>
              {trunk.status === 'active' ? (
                <Button type="button" variant="outline" onClick={() => setConfirm('disable')}>
                  {m.disable}
                </Button>
              ) : (
                <Button type="button" onClick={() => void setStatus('active')} disabled={update.isPending}>
                  {m.enable}
                </Button>
              )}
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirm === 'rotate'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={m.rotateTitle}
        description={m.rotateDescription}
        confirmLabel={m.rotateConfirm}
        onConfirm={newPassword}
      />
      <ConfirmDialog
        open={confirm === 'disable'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={m.disableTitle}
        description={m.disableDescription}
        confirmLabel={m.disable}
        onConfirm={async () => {
          await setStatus('disabled');
          setConfirm(null);
        }}
      />
      <ConfirmDialog
        open={confirm === 'delete'}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={m.deleteTitle}
        description={m.deleteDescription}
        confirmLabel={m.deleteConfirm}
        variant="destructive"
        onConfirm={deleteTrunk}
      />
    </>
  );
}
