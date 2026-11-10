/**
 * "Connect a phone system": three steps. 1: name, phone system, how it signs
 * in (IP address or username and password) and transport. 2: what to enter
 * in the phone system (the password is shown once). 3: add its numbers.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@weldsuite/ui/components/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog';
import { InfoBanner } from '@weldsuite/ui/components/info-banner';
import { InlineError } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import {
  DESK_SIP_TRUNK_PROVIDERS,
  DESK_SIP_TRUNK_TRANSPORTS,
  type DeskSipTrunkCreated,
} from '@weldsuite/core-api-client/schemas/desk-sip-trunks';
import { getTranslations } from '@/lib/i18n';
import { useCreateDeskSipTrunk, useDeskSipTrunks } from '@/hooks/queries/use-desk-sip-trunk-queries';
import { SipConnectionDetails } from './sip-connection-details';
import { SipIpListEditor } from './sip-ip-list-editor';
import { SipTrunkNumbers } from './sip-trunk-numbers';
import {
  emptySipTrunkForm,
  sipTrunkFormToInput,
  validateSipTrunkForm,
  type SipAuthMode,
  type SipFormError,
  type SipProvider,
  type SipTransport,
  type SipTrunkFormValues,
} from './sip-trunk-form';

const TOTAL_STEPS = 3;

export interface ConnectSipTrunkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canEdit: boolean;
}

export function ConnectSipTrunkDialog({ open, onOpenChange, canEdit }: Readonly<ConnectSipTrunkDialogProps>) {
  const t = getTranslations('deskSipTrunks');
  const w = t.wizard;
  const [step, setStep] = useState(1);
  const [values, setValues] = useState<SipTrunkFormValues>(emptySipTrunkForm);
  const [errors, setErrors] = useState<SipFormError[]>([]);
  const [created, setCreated] = useState<DeskSipTrunkCreated | null>(null);
  const create = useCreateDeskSipTrunk();
  const trunks = useDeskSipTrunks();

  const set = <K extends keyof SipTrunkFormValues>(key: K, value: SipTrunkFormValues[K]) =>
    setValues((prev) => ({ ...prev, [key]: value }));

  const close = (next: boolean) => {
    if (!next) {
      // The one-time password goes with the dialog.
      setStep(1);
      setValues(emptySipTrunkForm());
      setErrors([]);
      setCreated(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    const found = validateSipTrunkForm(values);
    setErrors(found);
    if (found.length > 0) return;
    try {
      setCreated(await create.mutateAsync(sipTrunkFormToInput(values)));
      toast.success(w.created);
      setStep(2);
    } catch {
      toast.error(w.createFailed);
    }
  };

  // Step 3 reads the live numbers; the created trunk has none yet.
  const liveTrunk = created ? trunks.data?.find((trunk) => trunk.id === created.id) : undefined;
  const numbers = liveTrunk?.numbers ?? created?.numbers ?? [];
  const nameError = errors.some((e) => e.kind === 'name');

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl" data-testid="connect-sip-trunk">
        <DialogHeader>
          <DialogTitle>{w.title}</DialogTitle>
          <DialogDescription>
            {w.description} <span className="font-medium">{w.stepLabel.replace('{current}', String(step)).replace('{total}', String(TOTAL_STEPS))}</span>
          </DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-4" data-testid="sip-step-one">
            <h3 className="font-medium">{w.one.title}</h3>
            <div className="space-y-1.5">
              <Label htmlFor="sip-trunk-name">{w.one.name}</Label>
              <Input
                id="sip-trunk-name"
                value={values.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder={w.one.namePlaceholder}
                aria-invalid={nameError}
              />
              {nameError && <InlineError>{w.errors.nameRequired}</InlineError>}
            </div>

            <div className="space-y-2">
              <Label>{w.one.provider}</Label>
              <RadioGroup
                value={values.provider}
                onValueChange={(value) => set('provider', value as SipProvider)}
                className="grid-cols-1 sm:grid-cols-3"
              >
                {DESK_SIP_TRUNK_PROVIDERS.map((provider) => (
                  <div key={provider} className="flex items-center gap-2">
                    <RadioGroupItem value={provider} id={`sip-provider-${provider}`} />
                    <Label htmlFor={`sip-provider-${provider}`}>{t.providers[provider]}</Label>
                  </div>
                ))}
              </RadioGroup>
            </div>

            <div className="space-y-2">
              <Label>{w.one.signIn}</Label>
              <RadioGroup value={values.authMode} onValueChange={(value) => set('authMode', value as SipAuthMode)}>
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="ip" id="sip-auth-ip" className="mt-1" />
                  <div>
                    <Label htmlFor="sip-auth-ip">{w.one.signInIp}</Label>
                    <p className="text-xs text-muted-foreground">{w.one.signInIpHelp}</p>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <RadioGroupItem value="credentials" id="sip-auth-credentials" className="mt-1" />
                  <div>
                    <Label htmlFor="sip-auth-credentials">{w.one.signInCredentials}</Label>
                    <p className="text-xs text-muted-foreground">{w.one.signInCredentialsHelp}</p>
                  </div>
                </div>
              </RadioGroup>
            </div>

            {values.authMode === 'ip' && (
              <div className="space-y-1.5">
                <Label>{w.one.ipAddresses}</Label>
                <p className="text-xs text-muted-foreground">{w.one.ipAddressesHelp}</p>
                <SipIpListEditor rows={values.ips} onChange={(rows) => set('ips', rows)} errors={errors} />
              </div>
            )}

            <div className="space-y-2">
              <Label>{w.one.transport}</Label>
              <RadioGroup
                value={values.transport}
                onValueChange={(value) => set('transport', value as SipTransport)}
                className="grid-cols-1 sm:grid-cols-3"
              >
                {DESK_SIP_TRUNK_TRANSPORTS.map((transport) => (
                  <div key={transport} className="flex items-center gap-2">
                    <RadioGroupItem value={transport} id={`sip-transport-${transport}`} />
                    <Label htmlFor={`sip-transport-${transport}`}>{t.transports[transport]}</Label>
                  </div>
                ))}
              </RadioGroup>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => close(false)}>
                {t.manage.close}
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={create.isPending || !canEdit}>
                {create.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {create.isPending ? w.creating : w.create}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 2 && created && (
          <div className="space-y-4" data-testid="sip-step-two">
            <h3 className="font-medium">{w.two.title}</h3>
            <InfoBanner variant="info">{created.authMode === 'ip' ? w.two.ipIntro : w.two.intro}</InfoBanner>
            <SipConnectionDetails
              connection={created.connection}
              authMode={created.authMode}
              ipAddresses={created.ipAddresses}
              password={created.credentials?.password ?? null}
            />
            <DialogFooter>
              <Button type="button" onClick={() => setStep(3)}>
                {w.next}
              </Button>
            </DialogFooter>
          </div>
        )}

        {step === 3 && created && (
          <div className="space-y-4" data-testid="sip-step-three">
            <h3 className="font-medium">{w.three.title}</h3>
            <p className="text-sm text-muted-foreground">{w.three.intro}</p>
            <SipTrunkNumbers trunkId={created.id} numbers={numbers} canEdit={canEdit} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setStep(2)}>
                {w.back}
              </Button>
              <Button type="button" onClick={() => close(false)}>
                {w.done}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
