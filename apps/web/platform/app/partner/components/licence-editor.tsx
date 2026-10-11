/**
 * The licence form: apps, credits, seats, feature plan and the partner's own
 * price. Controlled by the parent, which owns the draft and validates it with
 * `parseDraft` on submit.
 */

import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@weldsuite/ui/components/select';
import { Textarea } from '@weldsuite/ui/components/textarea';
import type { PartnerCatalog, PartnerLicencePackage } from '@weldsuite/app-api-client/domains/partners';
import { useI18n } from '@/lib/i18n/provider';
import {
  draftFromPackage,
  type LicenceDraft,
  type LicenceDraftErrors,
  type LicenceDraftField,
} from '../lib/licence-draft';

const CUSTOM = '__custom';
const DEFAULT_PLAN = '__default';

interface LicenceEditorProps {
  draft: LicenceDraft;
  onChange: (draft: LicenceDraft) => void;
  errors?: LicenceDraftErrors;
  catalog: PartnerCatalog | undefined;
  /** Offer "start from a package". Omit for package editing. */
  packages?: PartnerLicencePackage[];
  disabled?: boolean;
  showReason?: boolean;
  /** Prefix for input ids, so two editors on a page do not clash. */
  idPrefix?: string;
}

function FieldError({ id, message }: Readonly<{ id: string; message: string | undefined }>) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="text-xs text-destructive">
      {message}
    </p>
  );
}

export function LicenceEditor({
  draft,
  onChange,
  errors = {},
  catalog,
  packages,
  disabled,
  showReason,
  idPrefix = 'licence',
}: Readonly<LicenceEditorProps>) {
  const { t } = useI18n();
  const tl = t.partner.licence;
  const set = (patch: Partial<LicenceDraft>) => onChange({ ...draft, ...patch });
  const msg = (field: LicenceDraftField) => (errors[field] ? tl[errors[field]!] : undefined);
  const id = (name: string) => `${idPrefix}-${name}`;

  const catalogApps = catalog?.apps ?? [];
  const knownCodes = new Set(catalogApps.map((a) => a.code));
  // A licence may hold an app the catalog no longer lists: keep it visible so
  // saving does not silently drop it.
  const apps = [
    ...catalogApps,
    ...draft.allowedApps.filter((code) => !knownCodes.has(code)).map((code) => ({ code, name: code, icon: null })),
  ];

  const toggleApp = (code: string, on: boolean) =>
    set({
      allowedApps: on
        ? [...new Set([...draft.allowedApps, code])]
        : draft.allowedApps.filter((c) => c !== code),
    });

  const onPackage = (value: string) => {
    if (value === CUSTOM) {
      set({ packageId: null });
      return;
    }
    const pkg = packages?.find((p) => p.id === value);
    if (pkg) onChange({ ...draftFromPackage(pkg), reason: draft.reason });
  };

  const perSeat = draft.pricingModel === 'per_seat';

  return (
    <div className="space-y-5">
      {packages && packages.length > 0 && (
        <div className="grid gap-1.5">
          <Label htmlFor={id('package')}>{tl.package}</Label>
          <Select value={draft.packageId ?? CUSTOM} onValueChange={onPackage} disabled={disabled}>
            <SelectTrigger id={id('package')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CUSTOM}>{tl.packageCustom}</SelectItem>
              {packages.map((pkg) => (
                <SelectItem key={pkg.id} value={pkg.id}>
                  {pkg.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{tl.packageHint}</p>
        </div>
      )}

      <fieldset className="grid gap-2" disabled={disabled}>
        <legend className="mb-1 text-sm font-medium">{tl.apps}</legend>
        <p className="text-xs text-muted-foreground">{tl.appsHint}</p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {apps.map((app) => {
            const checked = draft.allowedApps.includes(app.code);
            return (
              <label
                key={app.code}
                htmlFor={id(`app-${app.code}`)}
                className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-accent/50"
              >
                <Checkbox
                  id={id(`app-${app.code}`)}
                  checked={checked}
                  onCheckedChange={(v) => toggleApp(app.code, v === true)}
                />
                <span className="truncate">{app.name}</span>
              </label>
            );
          })}
        </div>
        {draft.allowedApps.length === 0 && <p className="text-xs text-muted-foreground">{tl.appsNone}</p>}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor={id('credits')}>{tl.credits}</Label>
          <Input
            id={id('credits')}
            inputMode="numeric"
            value={draft.monthlyCredits}
            onChange={(e) => set({ monthlyCredits: e.target.value })}
            disabled={disabled}
            aria-invalid={Boolean(errors.monthlyCredits)}
            aria-describedby={errors.monthlyCredits ? id('credits-error') : undefined}
          />
          <FieldError id={id('credits-error')} message={msg('monthlyCredits')} />
          <p className="text-xs text-muted-foreground">{tl.creditsHint}</p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={id('rollover')}>{tl.rollover}</Label>
          <Input
            id={id('rollover')}
            inputMode="numeric"
            value={draft.creditRolloverCap}
            onChange={(e) => set({ creditRolloverCap: e.target.value })}
            disabled={disabled}
            aria-invalid={Boolean(errors.creditRolloverCap)}
          />
          <FieldError id={id('rollover-error')} message={msg('creditRolloverCap')} />
          <p className="text-xs text-muted-foreground">{tl.rolloverHint}</p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={id('max-seats')}>{tl.maxSeats}</Label>
          <Input
            id={id('max-seats')}
            inputMode="numeric"
            placeholder={tl.maxSeatsPlaceholder}
            value={draft.maxSeats}
            onChange={(e) => set({ maxSeats: e.target.value })}
            disabled={disabled}
            aria-invalid={Boolean(errors.maxSeats)}
          />
          <FieldError id={id('max-seats-error')} message={msg('maxSeats')} />
          <p className="text-xs text-muted-foreground">{tl.maxSeatsHint}</p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={id('storage')}>{tl.storage}</Label>
          <Input
            id={id('storage')}
            inputMode="numeric"
            value={draft.storageGb}
            onChange={(e) => set({ storageGb: e.target.value })}
            disabled={disabled}
            aria-invalid={Boolean(errors.storageGb)}
          />
          <FieldError id={id('storage-error')} message={msg('storageGb')} />
          <p className="text-xs text-muted-foreground">{tl.storageHint}</p>
        </div>
      </div>

      {catalog && catalog.featurePlans.length > 0 && (
        <div className="grid gap-1.5">
          <Label htmlFor={id('feature-plan')}>{tl.featurePlan}</Label>
          <Select
            value={draft.featurePlanId ?? DEFAULT_PLAN}
            onValueChange={(v) => set({ featurePlanId: v === DEFAULT_PLAN ? null : v })}
            disabled={disabled}
          >
            <SelectTrigger id={id('feature-plan')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT_PLAN}>{tl.featurePlanDefault}</SelectItem>
              {catalog.featurePlans.map((plan) => (
                <SelectItem key={plan.id} value={plan.id}>
                  {plan.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">{tl.featurePlanHint}</p>
        </div>
      )}

      <div className="space-y-3 rounded-xl border p-4">
        <h3 className="text-sm font-semibold">{tl.pricing}</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label htmlFor={id('pricing-model')}>{tl.pricingModel}</Label>
            <Select
              value={draft.pricingModel}
              onValueChange={(v) => set({ pricingModel: v === 'per_seat' ? 'per_seat' : 'flat' })}
              disabled={disabled}
            >
              <SelectTrigger id={id('pricing-model')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="flat">{tl.pricingFlat}</SelectItem>
                <SelectItem value="per_seat">{tl.pricingPerSeat}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor={id('amount')}>{tl.amount}</Label>
            <Input
              id={id('amount')}
              inputMode="decimal"
              placeholder="199.00"
              value={draft.amount}
              onChange={(e) => set({ amount: e.target.value })}
              disabled={disabled}
              aria-invalid={Boolean(errors.amount)}
              aria-describedby={errors.amount ? id('amount-error') : undefined}
            />
            <FieldError id={id('amount-error')} message={msg('amount')} />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">{perSeat ? tl.amountPerSeatHint : tl.amountFlatHint}</p>

        {perSeat && (
          <div className="grid gap-1.5 sm:max-w-[50%]">
            <Label htmlFor={id('min-seats')}>{tl.minSeats}</Label>
            <Input
              id={id('min-seats')}
              inputMode="numeric"
              value={draft.minSeats}
              onChange={(e) => set({ minSeats: e.target.value })}
              disabled={disabled}
              aria-invalid={Boolean(errors.minSeats)}
            />
            <FieldError id={id('min-seats-error')} message={msg('minSeats')} />
            <p className="text-xs text-muted-foreground">{tl.minSeatsHint}</p>
          </div>
        )}
      </div>

      {showReason && (
        <div className="grid gap-1.5">
          <Label htmlFor={id('reason')}>{tl.reason}</Label>
          <Textarea
            id={id('reason')}
            rows={2}
            value={draft.reason}
            onChange={(e) => set({ reason: e.target.value })}
            disabled={disabled}
          />
        </div>
      )}
    </div>
  );
}
