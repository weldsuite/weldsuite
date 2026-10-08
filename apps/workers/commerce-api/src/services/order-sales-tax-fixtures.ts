/**
 * Seed data for the order sales tax tests. The rates are invented: real rates
 * go stale, and a test must never depend on them.
 *
 * Entity `ent_us` sells from Austin, Texas (ZIP 78701), is registered with the
 * Texas Comptroller and taxes at 6.25% state + 2.00% city = 8.25%. Entity
 * `ent_nl` is a Dutch company, `ent_stripe` a US company on the Stripe Tax
 * engine, once without credentials and once with.
 */

import { encryptField } from '@weldsuite/db/lib/crypto';
import { schema, type Database } from '@weldsuite/worker-kit/db';

export const ENCRYPTION_KEY = 'ab'.repeat(32);

export const TX_ADDRESS = { line1: '500 Congress Ave', city: 'Austin', state: 'TX', postalCode: '78701', country: 'US' };
export const CA_ADDRESS = { line1: '1 Market St', city: 'San Francisco', state: 'CA', postalCode: '94105', country: 'US' };

export const ENTITIES = {
  us: 'ent_us',
  nl: 'ent_nl',
  stripeNoCredentials: 'ent_stripe_none',
  stripe: 'ent_stripe',
} as const;

export async function seedTaxWorkspace(db: Database): Promise<void> {
  const base = { locale: 'en-US', timezone: 'America/Chicago' };
  await db.insert(schema.entities).values([
    { id: ENTITIES.us, name: 'Lone Star Goods LLC', jurisdictionCode: 'US', baseCurrency: 'USD', address: TX_ADDRESS, isDefault: true, ...base },
    { id: ENTITIES.nl, name: 'Tulpen BV', jurisdictionCode: 'NL', baseCurrency: 'EUR', locale: 'nl-NL', timezone: 'Europe/Amsterdam' },
    { id: ENTITIES.stripeNoCredentials, name: 'Stripe Co', jurisdictionCode: 'US', baseCurrency: 'USD', address: TX_ADDRESS, salesTaxEngine: 'stripe_tax', ...base },
    {
      id: ENTITIES.stripe,
      name: 'Stripe Co With Key',
      jurisdictionCode: 'US',
      baseCurrency: 'USD',
      address: TX_ADDRESS,
      salesTaxEngine: 'stripe_tax',
      salesTaxCredentialsEncrypted: await encryptField(JSON.stringify({ apiKey: 'sk_test_fixture' }), { v1: ENCRYPTION_KEY }),
      ...base,
    },
  ]);
  await db.insert(schema.settings).values({ id: 'set_tax', defaultEntityId: ENTITIES.us });

  const entityId = ENTITIES.us;
  await db.insert(schema.salesTaxAgencies).values([
    { id: 'ag_tx', entityId, stateCode: 'TX', name: 'Texas Comptroller', status: 'registered', registeredFrom: '2024-01-01' },
    // The provider is only asked where the entity is registered.
    { id: 'ag_tx_stripe', entityId: ENTITIES.stripe, stateCode: 'TX', name: 'Texas Comptroller', status: 'registered', registeredFrom: '2024-01-01' },
  ]);
  await db.insert(schema.salesTaxJurisdictions).values([
    { id: 'j_tx_state', entityId, agencyId: 'ag_tx', stateCode: 'TX', level: 'state', name: 'Texas', code: '48' },
    { id: 'j_tx_city', entityId, agencyId: 'ag_tx', stateCode: 'TX', level: 'city', name: 'Austin', code: '48-05000' },
  ]);
  await db.insert(schema.salesTaxJurisdictionRates).values([
    { id: 'r_tx_state', entityId, jurisdictionId: 'j_tx_state', rate: '6.2500', effectiveFrom: '2020-01-01' },
    { id: 'r_tx_city', entityId, jurisdictionId: 'j_tx_city', rate: '2.0000', effectiveFrom: '2020-01-01' },
  ]);
  await db.insert(schema.salesTaxZones).values({
    id: 'z_tx_austin',
    entityId,
    agencyId: 'ag_tx',
    stateCode: 'TX',
    name: 'Austin',
    jurisdictionIds: ['j_tx_state', 'j_tx_city'],
    postalCodes: ['78701'],
    isOrigin: true,
  });
  // SaaS is not taxed for business buyers here, so the use a buyer defaults to shows in the result.
  await db.insert(schema.salesTaxTaxabilityRules).values({
    id: 'rule_saas_business',
    entityId,
    agencyId: 'ag_tx',
    taxCode: 'saas',
    taxable: false,
    appliesToUse: 'business',
    effectiveFrom: '2020-01-01',
  });

  await db.insert(schema.products).values([
    { id: 'prod_general', name: 'Mug', slug: 'mug', taxClass: 'general' },
    { id: 'prod_exempt', name: 'Donation', slug: 'donation', taxClass: 'non_taxable' },
    { id: 'prod_saas', name: 'Subscription', slug: 'subscription', taxClass: 'saas' },
    { id: 'prod_legacy', name: 'Legacy', slug: 'legacy', taxClass: 'standard' },
    { id: 'prod_untaxed', name: 'Gift wrap', slug: 'gift-wrap', taxable: false, taxClass: 'general' },
  ]);
}
