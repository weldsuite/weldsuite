/**
 * `AddressPropertyRow` — Details-tab row for a record's primary address.
 *
 * Reads and writes the shared `PostalAddress` shape that the CRM tables store
 * in `primary_address` (`line1`, `line2`, `city`, `state`, `postalCode`,
 * `country` as an ISO-2 code). Rows written by older code with `street` /
 * `houseNumber` keys still display, and are migrated to `line1` the next time
 * the address is saved.
 *
 * Clicking the value opens an editor popover (the same `AddressFields` the
 * accounting forms use); saving an empty form clears the address.
 */

import { useMemo, useState, type ComponentType } from 'react';
import { useTranslations } from '@weldsuite/i18n/client';
import { useI18n } from '@/lib/i18n/provider';
import { Button } from '@weldsuite/ui/components/button';
import { Popover, PopoverContent, PopoverTrigger } from '@weldsuite/ui/components/popover';
import { AddressFields } from '@/components/address/address-fields';
import { countryName } from '@/components/address/countries';
import {
  cleanPostalAddress,
  formatPostalAddressLines,
  isPostalAddressEmpty,
  toPostalAddressFormValue,
  type PostalAddress,
} from '@/components/address/postal-address';

/** What the API returns for `primaryAddress`: the shared shape plus legacy / extra keys. */
export type StoredAddress = Record<string, unknown> | null | undefined;

const KNOWN_KEYS = new Set(['line1', 'line2', 'city', 'state', 'postalCode', 'country']);
const LEGACY_STREET_KEYS = new Set(['street', 'houseNumber']);

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/** Normalize a stored address (shared shape or legacy `street` shape) to `PostalAddress`. */
export function toPostalAddress(stored: StoredAddress): PostalAddress {
  if (!stored) return {};
  const legacyLine1 = [str(stored.street), str(stored.houseNumber)].filter(Boolean).join(' ');
  return {
    line1: str(stored.line1) ?? (legacyLine1 || undefined),
    line2: str(stored.line2),
    city: str(stored.city),
    state: str(stored.state) ?? str(stored.province),
    postalCode: str(stored.postalCode),
    country: str(stored.country),
  };
}

/** One-line display of a stored address, `''` when empty. */
export function formatStoredAddress(stored: StoredAddress, language = 'en'): string {
  const lines = formatPostalAddressLines(toPostalAddress(stored), {
    countryName: (code) => (code.length === 2 ? countryName(code, language) : code),
  });
  return lines.join(', ');
}

/**
 * The value to PATCH for an edited address: the cleaned shared shape, merged
 * over any extra keys the stored object carried (minus the legacy street keys
 * it is replacing). `null` when the address was emptied.
 */
export function buildAddressPatch(
  stored: StoredAddress,
  edited: PostalAddress,
): Record<string, unknown> | null {
  const cleaned = cleanPostalAddress(edited);
  if (!cleaned) return null;
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(stored ?? {})) {
    if (!KNOWN_KEYS.has(k) && !LEGACY_STREET_KEYS.has(k) && k !== 'province') extras[k] = v;
  }
  return { ...extras, ...cleaned };
}

export interface AddressPropertyRowProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: StoredAddress;
  placeholder: string;
  /** Called with the new address object, or `null` when the user cleared it. */
  onSave: (next: Record<string, unknown> | null) => void | Promise<void>;
}

export function AddressPropertyRow({
  icon: Icon,
  label,
  value,
  placeholder,
  onSave,
}: Readonly<AddressPropertyRowProps>) {
  const st = useTranslations();
  const { language } = useI18n();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PostalAddress>(() => toPostalAddressFormValue(toPostalAddress(value)));
  const [saving, setSaving] = useState(false);

  const display = useMemo(() => formatStoredAddress(value, language || 'en'), [value, language]);

  const handleOpenChange = (next: boolean) => {
    // Re-seed from the latest stored value each time the editor opens.
    if (next) setDraft(toPostalAddressFormValue(toPostalAddress(value)));
    setOpen(next);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const patch = isPostalAddressEmpty(draft) ? null : buildAddressPatch(value, draft);
      await onSave(patch);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="grid grid-cols-[120px_minmax(0,1fr)_auto] gap-2 items-center group/row min-h-[32px]">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon className="h-4 w-4" />
        <span>{label}</span>
      </div>
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            // No hover box: the value (or placeholder) underlines on hover,
            // like the other picker rows.
            className="group/field text-sm min-w-0 justify-self-start min-h-[32px] py-1 text-left cursor-pointer rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {display ? (
              <span className="text-foreground break-words [overflow-wrap:anywhere] group-hover/field:underline">{display}</span>
            ) : (
              <span className="text-muted-foreground group-hover/field:underline">{placeholder}</span>
            )}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-[22rem] max-w-[calc(100vw-2rem)] p-4" align="start">
          <AddressFields
            value={draft}
            onChange={setDraft}
            idPrefix={`property-address-${label}`}
            disabled={saving}
            className="gap-3"
          />
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" variant="outline" size="sm" disabled={saving} onClick={() => setOpen(false)}>
              {st('sweep.entities.cancel')}
            </Button>
            <Button type="button" size="sm" disabled={saving} onClick={() => void handleSave()}>
              {st('sweep.entities.save')}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      <div />
    </div>
  );
}
