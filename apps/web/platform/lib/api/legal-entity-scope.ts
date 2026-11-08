/**
 * The legal entity the signed-in member works in, mirrored out of React state
 * so request code (which runs outside React) can send it.
 *
 * - WeldBooks: `weldbooks-client.ts` has its own mirror and sends it as
 *   `X-Accounting-Entity-Id` plus `X-Legal-Entity-Id`.
 * - WeldHR: `useAppApi()` sends `X-Legal-Entity-Id` on the weldhr and payroll
 *   domains only. The id here is always one WeldHR is enabled for (or null),
 *   so hr-api never receives an entity it would refuse. Null means "no
 *   header": hr-api then spans the entities the member acts in.
 */

let hrLegalEntityId: string | null = null;

export function setHrLegalEntityId(id: string | null) {
  hrLegalEntityId = id;
}

export function getHrLegalEntityId(): string | null {
  return hrLegalEntityId;
}

/** Headers WeldHR requests carry. */
export function hrLegalEntityHeaders(): Record<string, string> {
  return hrLegalEntityId ? { 'X-Legal-Entity-Id': hrLegalEntityId } : {};
}
