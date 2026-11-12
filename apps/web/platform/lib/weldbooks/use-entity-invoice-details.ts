import { useMemo } from 'react';
import { useAccountingEntity, useAccountingJurisdictions } from '@/hooks/queries/use-accounting-queries';
import { useCurrentAccountingEntity } from '@/hooks/use-current-accounting-entity';
import type { AccountingEntity } from '@/lib/api/domains/weldbooks';
import { useI18n } from '@/lib/i18n/provider';
import { DEFAULT_TERMINOLOGY } from './jurisdiction';
import { missingInvoiceFields, requiredInvoiceFields, type InvoiceField } from './invoice-requirements';
import { useTerminologyLabels } from './use-jurisdiction';

export interface EntityInvoiceDetails {
  /** The selected entity, with its tax identifiers, bank details and address. */
  entity: AccountingEntity | undefined;
  /** The fields an invoice needs that the entity has not filled in; empty until the entity has loaded. */
  missing: InvoiceField[];
  /** What each field is called in the entity's jurisdiction ("Btw-nummer", "GSTIN", ...). */
  labels: Record<InvoiceField, string>;
  isLoading: boolean;
}

/**
 * The company details the selected entity still lacks for an invoice to be
 * issued (books-api's `ENTITY_INVOICE_FIELDS_MISSING` check, asked up front).
 */
export function useEntityInvoiceDetails(): EntityInvoiceDetails {
  const { t } = useI18n();
  const te = t.accounting.entityEdit;
  const { entityId } = useCurrentAccountingEntity();
  const entityQuery = useAccountingEntity(entityId);
  const { data: jurisdictions } = useAccountingJurisdictions();
  const entity = entityQuery.data;

  const code = entity?.jurisdictionCode?.toUpperCase() ?? null;
  const terminology = jurisdictions?.find((j) => j.code.toUpperCase() === code)?.terminology ?? DEFAULT_TERMINOLOGY;
  const terms = useTerminologyLabels(terminology);

  const missing = useMemo(
    () => (entity ? missingInvoiceFields(entity, requiredInvoiceFields(entity.jurisdictionCode, jurisdictions)) : []),
    [entity, jurisdictions],
  );
  const labels = useMemo<Record<InvoiceField, string>>(
    () => ({
      vatNumber: terms.taxId,
      registrationNumber: terms.registrationId,
      iban: te.iban,
      bic: te.bic,
      address: t.accounting.entityInvoiceDetails.businessAddress,
    }),
    [terms.taxId, terms.registrationId, te.iban, te.bic, t.accounting.entityInvoiceDetails.businessAddress],
  );

  return { entity, missing, labels, isLoading: entityQuery.isLoading };
}
