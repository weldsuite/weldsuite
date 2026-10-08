/**
 * Postal address shape shared by accounting documents, entities and parties.
 *
 * It matches the CRM `parties` / `companies` / `orders` address (line1, line2,
 * city, state, postalCode, country). `state` holds a state, province or region;
 * for US addresses it is the USPS code.
 */
export interface PostalAddress {
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  county?: string;
}

/**
 * The Dutch-style shape accounting rows were written in before the shared
 * address (street + houseNumber, province). Older rows still carry it; read
 * them through `normalizePostalAddress` in `@weldsuite/books-domain`.
 */
export interface LegacyAccountingAddress {
  street?: string;
  houseNumber?: string;
  province?: string;
}

/** What an address column on an accounting row may contain. */
export type StoredPostalAddress = PostalAddress & LegacyAccountingAddress;
