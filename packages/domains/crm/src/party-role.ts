/**
 * The accounting role of a party (customer | supplier | both | none) once its
 * company or person is flagged as a supplier in the CRM: the supplier role is
 * added, a customer role is kept.
 */
export function withSupplierRole(role: string | null | undefined): string {
  if (role === 'customer' || role === 'both') return 'both';
  return 'supplier';
}
