import { useId, useState } from 'react';
import { MapPin, Search } from 'lucide-react';
import { Button } from '@weldsuite/ui/components/button';
import { ErrorBanner } from '@weldsuite/ui/components/error-banner';
import { Input } from '@weldsuite/ui/components/input';
import { InlineSpinner } from '@weldsuite/ui/components/page-loader';
import { Label } from '@weldsuite/ui/components/label';
import { RadioGroup, RadioGroupItem } from '@weldsuite/ui/components/radio-group';
import { SoftBadge } from '@weldsuite/ui/components/soft-badge';
import type { ServicePoint, ServicePointAddress, ServicePointChoice } from '@weldsuite/app-api-client/schemas/shipping';
import { useServicePoints } from '@/hooks/queries/use-shipping-queries';
import { getLocale, getTranslations } from '@/lib/i18n';

interface ServicePointPickerProps {
  carrierId: string;
  country: string;
  defaultPostalCode: string;
  defaultHouseNumber: string;
  value: ServicePointChoice | null;
  onChange: (choice: ServicePointChoice | null) => void;
  invalid?: boolean;
}

export function formatServicePointAddress(address: ServicePointAddress | null | undefined): string {
  if (!address) return '';
  const street = [address.street, `${address.houseNumber ?? ''}${address.houseNumberSuffix ?? ''}`.trim()].filter(Boolean).join(' ');
  return [street, [address.postalCode, address.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

function formatDistance(meters: number | null, locale: string): string | null {
  if (meters === null || !Number.isFinite(meters)) return null;
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(meters / 1000)} km`;
}

/** Postal code and house number search, then one service point picked from the list. */
export function ServicePointPicker({
  carrierId,
  country,
  defaultPostalCode,
  defaultHouseNumber,
  value,
  onChange,
  invalid,
}: Readonly<ServicePointPickerProps>) {
  const t = getTranslations('weldstash').shipping.labels;
  const locale = getLocale();
  const id = useId();
  const [postalCode, setPostalCode] = useState(defaultPostalCode);
  const [houseNumber, setHouseNumber] = useState(defaultHouseNumber);
  const [searched, setSearched] = useState<{ postalCode: string; houseNumber: string } | null>(null);

  const results = useServicePoints(
    carrierId,
    searched ? { country, postalCode: searched.postalCode, houseNumber: searched.houseNumber || undefined, limit: 10 } : null,
  );

  const search = () => {
    if (!postalCode.trim()) return;
    setSearched({ postalCode: postalCode.trim(), houseNumber: houseNumber.trim() });
  };

  const choose = (point: ServicePoint) =>
    onChange({ id: point.id, name: point.name, address: point.address, networkId: point.networkId });

  if (value) {
    return (
      <div className="flex items-start justify-between gap-3 rounded-md border p-3">
        <div className="flex min-w-0 items-start gap-2">
          <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0 text-sm">
            <p className="truncate font-medium">{value.name}</p>
            <p className="text-muted-foreground">{formatServicePointAddress(value.address)}</p>
          </div>
        </div>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange(null)}>
          {t.servicePointChange}
        </Button>
      </div>
    );
  }

  const points = results.data ?? [];
  return (
    <div className="space-y-3" aria-invalid={invalid || undefined}>
      <div className="flex flex-wrap items-end gap-2">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-postal`}>
            {getTranslations('weldstash').shipping.address.postalCode}
          </Label>
          <Input
            id={`${id}-postal`}
            className="w-32"
            value={postalCode}
            autoComplete="postal-code"
            onChange={(e) => setPostalCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                search();
              }
            }}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-number`}>
            {getTranslations('weldstash').shipping.address.houseNumber}
          </Label>
          <Input
            id={`${id}-number`}
            className="w-28"
            inputMode="numeric"
            value={houseNumber}
            onChange={(e) => setHouseNumber(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                search();
              }
            }}
          />
        </div>
        <Button type="button" variant="outline" onClick={search} disabled={!postalCode.trim() || results.isFetching}>
          {results.isFetching ? <InlineSpinner /> : <Search className="size-4" aria-hidden="true" />}
          {t.servicePointSearch}
        </Button>
      </div>

      <div aria-live="polite">
        {results.isError ? <ErrorBanner error={(results.error as Error).message || t.servicePointError} /> : null}
        {searched && results.isSuccess && points.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.servicePointNone}</p>
        ) : null}
      </div>

      {points.length > 0 ? (
        <RadioGroup
          aria-label={t.servicePoint}
          className="gap-2"
          value=""
          onValueChange={(next) => {
            const point = points.find((p) => p.id === next);
            if (point) choose(point);
          }}
        >
          {points.map((point) => {
            const distance = formatDistance(point.distanceMeters, locale);
            const itemId = `${id}-${point.id}`;
            return (
              <div key={point.id} className="flex items-start gap-3 rounded-md border p-3">
                <RadioGroupItem id={itemId} value={point.id} className="mt-1" />
                <Label htmlFor={itemId} className="block min-w-0 flex-1 cursor-pointer font-normal">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {point.name}
                    {point.locker ? <SoftBadge tone="neutral">{t.servicePointLocker}</SoftBadge> : null}
                  </span>
                  <span className="block text-sm text-muted-foreground">{formatServicePointAddress(point.address)}</span>
                  {distance ? (
                    <span className="block text-xs text-muted-foreground">{t.servicePointDistance.replace('{distance}', distance)}</span>
                  ) : null}
                </Label>
              </div>
            );
          })}
        </RadioGroup>
      ) : null}
    </div>
  );
}
