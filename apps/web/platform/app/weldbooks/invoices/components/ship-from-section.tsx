import { Checkbox } from '@weldsuite/ui/components/checkbox';
import { AddressFields } from '@/components/address/address-fields';
import {
  formatPostalAddressLines,
  isPostalAddressEmpty,
  toPostalAddressFormValue,
  type PostalAddress,
} from '@/components/address/postal-address';
import { useDocumentTexts } from '@/lib/weldbooks/use-document-texts';

interface ShipFromSectionProps {
  idPrefix?: string;
  /** The entity's own address, which is the origin unless another one is given. */
  entityAddress: PostalAddress | null;
  shipFromDifferent: boolean;
  shipFromAddress: PostalAddress;
  onShipFromDifferentChange: (next: boolean) => void;
  onShipFromAddressChange: (next: PostalAddress) => void;
  /** Invoices only: sold through a marketplace that collects the tax. */
  marketplace?: { value: boolean; onChange: (next: boolean) => void };
}

/**
 * Where a US sale ships from, and whether a marketplace facilitator collects
 * its tax. The origin defaults to the entity's address and is collapsed; it
 * only matters in states that tax by the seller's location.
 */
export function ShipFromSection({
  idPrefix = 'shipfrom',
  entityAddress,
  shipFromDifferent,
  shipFromAddress,
  onShipFromDifferentChange,
  onShipFromAddressChange,
  marketplace,
}: Readonly<ShipFromSectionProps>) {
  const ts = useDocumentTexts().shipFrom;
  const entityLines = formatPostalAddressLines(entityAddress);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm" htmlFor={`${idPrefix}-different`}>
          <Checkbox
            id={`${idPrefix}-different`}
            checked={shipFromDifferent}
            onCheckedChange={(checked) => {
              const next = checked === true;
              onShipFromDifferentChange(next);
              if (next && isPostalAddressEmpty(shipFromAddress)) {
                onShipFromAddressChange(toPostalAddressFormValue(entityAddress));
              }
            }}
          />
          {ts.differentOrigin}
        </label>
        <p className="text-xs text-muted-foreground">{ts.originHelp}</p>
        {!shipFromDifferent && (
          <p className="text-xs text-muted-foreground">
            {entityLines.length > 0 ? ts.originDefault.replace('{address}', entityLines.join(', ')) : ts.originNone}
          </p>
        )}
      </div>

      {shipFromDifferent && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{ts.shipFromAddress}</p>
          <AddressFields idPrefix={`${idPrefix}-address`} value={shipFromAddress} onChange={onShipFromAddressChange} />
        </div>
      )}

      {marketplace && (
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm" htmlFor={`${idPrefix}-marketplace`}>
            <Checkbox
              id={`${idPrefix}-marketplace`}
              checked={marketplace.value}
              onCheckedChange={(checked) => marketplace.onChange(checked === true)}
            />
            {ts.marketplace}
          </label>
          <p className="text-xs text-muted-foreground">{ts.marketplaceHelp}</p>
        </div>
      )}
    </div>
  );
}
