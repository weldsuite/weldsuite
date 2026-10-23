import { getLocale } from '@weldsuite/i18n';

/**
 * Copy for the single sign-on card on the workspace billing tab, en + nl. Like
 * ./partners-copy.ts it lives with the console rather than in the `admin`
 * namespace of @weldsuite/i18n only because that package was owned by another
 * workstream while this was built; move it there when convenient (same shape:
 * nested objects, `{placeholder}` filled by `fill()` from ./i18n).
 */

const en = {
  title: 'Single sign-on',
  notConfigured: 'The billing worker is not configured for this console, so single sign-on cannot be shown or changed here.',
  loadFailed: 'Single sign-on could not be loaded: {message}',
  partnerNote: 'This workspace is billed by its partner, so single sign-on can only be granted for free here.',
  perMonth: '{amount} / month',
  yes: 'Yes',
  no: 'No',
  sections: {
    access: 'Access and price',
    addon: 'Add-on subscription',
    connection: 'Domain and connection',
  },
  entitlement: {
    plan: 'Included in the plan',
    free: 'Free (staff grant)',
    subscription: 'Paid add-on',
    none: 'No SSO',
  },
  access: {
    entitlement: 'SSO access',
    listPrice: 'List price',
    customPrice: 'Custom price',
    noCustomPrice: 'None, the list price applies',
    free: 'Free',
    billing: 'Billed',
    billingDirect: 'Directly by WeldSuite',
    billingPartner: 'By the partner',
    priceSetBy: 'Price set by {email} on {date}.',
  },
  addon: {
    status: 'Status',
    charged: 'Charged',
    chargedUnknown: 'Unknown (Stripe could not be asked)',
    renewsOn: 'Renews on',
    endsOn: 'Ends on',
    stripe: 'Stripe subscription',
    none: 'No add-on subscription.',
  },
  connection: {
    domain: 'Domain',
    noDomain: 'None claimed',
    verified: 'Verified',
    unverified: 'Not verified',
    provider: 'Identity provider',
    none: 'No connection set up.',
    enabled: 'Switched on by the workspace',
    active: 'Active in Clerk',
    lastChanged: 'Last changed',
    changedBy: '{date} by {email}',
    inactiveDomain: 'Not active: the domain is not verified.',
    inactiveEntitlement: 'Not active: nothing covers single sign-on for this workspace.',
    inactivePending: 'Not active in Clerk yet; the hourly sync retries.',
  },
  providers: {
    saml_okta: 'Okta',
    saml_microsoft: 'Microsoft Entra ID',
    saml_google: 'Google Workspace',
    saml_custom: 'Custom SAML',
  },
  actions: {
    setPrice: 'Set SSO price',
    revoke: 'Revoke SSO',
    disableConnection: 'Turn off SSO connection',
  },
  price: {
    title: 'Set the SSO price',
    description:
      'What this workspace pays for single sign-on each month. A running add-on is charged the new price from its next invoice.',
    mode: 'Price',
    list: 'List price',
    custom: 'Custom price',
    customHint: 'A monthly price for this workspace only.',
    free: 'Free',
    freeHint: 'Single sign-on is on straight away, at no charge.',
    amount: 'Amount per month',
    amountPlaceholder: 'For example 75 or 49.50',
    currency: 'Currency',
    currencyHint: 'Use the currency Stripe bills this customer in. Their list price is in {currency}.',
    invalidAmount: 'Enter an amount like 75 or 49.50.',
    zeroAmount: 'Enter an amount above 0, or choose Free.',
    tooHigh: 'The amount cannot be more than {max} a month.',
    switchOn: 'Switch SSO on now (bills the card on file)',
    switchOnHint:
      'Starts the add-on at this price and charges the customer’s default payment method. Leave it off to only save the price; it then applies when the workspace adds SSO in its Settings.',
    liveReprice: 'The running add-on is charged this price from its next invoice. Nothing is prorated.',
    liveCancel: 'The running add-on is cancelled at once with a prorated credit. Single sign-on stays on.',
    planIncludes: 'The plan already includes single sign-on. A price saved here only applies if the workspace moves to a plan without it.',
    partner: 'This workspace is billed by its partner, so only Free is available here.',
    submit: 'Save price',
    noCard:
      'The customer has no card on file to charge. Save the price without switching SSO on, or ask them to add a payment method.',
    successCreated: 'SSO add-on started.',
    successRepriced: 'Price saved. The add-on is charged it from the next invoice.',
    successCanceled: 'Single sign-on is now free, and the paid add-on was cancelled.',
    successSaved: 'SSO price saved.',
  },
  revoke: {
    title: 'Revoke single sign-on',
    description:
      'Clears the custom price and ends the paid add-on. Unless the plan includes it, the workspace loses single sign-on once nothing covers it any more.',
    periodEnd: 'At the end of the period',
    periodEndHint: 'Single sign-on keeps working until {date}, then the add-on ends.',
    immediately: 'Immediately',
    immediatelyHint: 'Ends the add-on now, with a prorated credit.',
    noAddon: 'There is no running add-on, so this only clears the price.',
    freeGrantEnds: 'The free grant ends straight away.',
    submit: 'Revoke SSO',
    successCanceled: 'SSO add-on cancelled.',
    successScheduled: 'The SSO add-on ends at the end of its period.',
    successCleared: 'SSO price cleared.',
  },
  disable: {
    title: 'Turn off the SSO connection',
    description:
      'The emergency switch for an identity provider that locks people out: Clerk stops sending the domain’s members to it. The configuration stays, and the workspace admin can switch the connection back on in Settings once the provider is fixed.',
    submit: 'Turn off connection',
    success: 'SSO connection turned off.',
    alreadyOff: 'The SSO connection was already off.',
  },
  /** Labels for the admin audit actions, shown in the activity tables. */
  activity: {
    'sso.grant': 'SSO price set',
    'sso.revoke': 'SSO revoked',
    'sso.connection.disable': 'SSO connection turned off',
  },
};

export type SsoCopy = typeof en;

const nl: SsoCopy = {
  title: 'Single sign-on',
  notConfigured: 'De billing-worker is niet ingesteld voor deze console, dus single sign-on kan hier niet worden getoond of gewijzigd.',
  loadFailed: 'Single sign-on kon niet worden geladen: {message}',
  partnerNote: 'Deze werkruimte wordt door haar partner gefactureerd, dus single sign-on kan hier alleen gratis worden toegekend.',
  perMonth: '{amount} / maand',
  yes: 'Ja',
  no: 'Nee',
  sections: {
    access: 'Toegang en prijs',
    addon: 'Add-on-abonnement',
    connection: 'Domein en verbinding',
  },
  entitlement: {
    plan: 'Inbegrepen in het plan',
    free: 'Gratis (toegekend door staf)',
    subscription: 'Betaalde add-on',
    none: 'Geen SSO',
  },
  access: {
    entitlement: 'SSO-toegang',
    listPrice: 'Catalogusprijs',
    customPrice: 'Eigen prijs',
    noCustomPrice: 'Geen, de catalogusprijs geldt',
    free: 'Gratis',
    billing: 'Gefactureerd',
    billingDirect: 'Rechtstreeks door WeldSuite',
    billingPartner: 'Door de partner',
    priceSetBy: 'Prijs ingesteld door {email} op {date}.',
  },
  addon: {
    status: 'Status',
    charged: 'In rekening gebracht',
    chargedUnknown: 'Onbekend (Stripe kon niet worden gevraagd)',
    renewsOn: 'Verlengt op',
    endsOn: 'Stopt op',
    stripe: 'Stripe-abonnement',
    none: 'Geen add-on-abonnement.',
  },
  connection: {
    domain: 'Domein',
    noDomain: 'Niet geclaimd',
    verified: 'Geverifieerd',
    unverified: 'Niet geverifieerd',
    provider: 'Identiteitsprovider',
    none: 'Geen verbinding ingesteld.',
    enabled: 'Aangezet door de werkruimte',
    active: 'Actief in Clerk',
    lastChanged: 'Laatst gewijzigd',
    changedBy: '{date} door {email}',
    inactiveDomain: 'Niet actief: het domein is niet geverifieerd.',
    inactiveEntitlement: 'Niet actief: niets dekt single sign-on voor deze werkruimte.',
    inactivePending: 'Nog niet actief in Clerk; de synchronisatie van elk uur probeert het opnieuw.',
  },
  providers: {
    saml_okta: 'Okta',
    saml_microsoft: 'Microsoft Entra ID',
    saml_google: 'Google Workspace',
    saml_custom: 'Eigen SAML',
  },
  actions: {
    setPrice: 'SSO-prijs instellen',
    revoke: 'SSO intrekken',
    disableConnection: 'SSO-verbinding uitzetten',
  },
  price: {
    title: 'De SSO-prijs instellen',
    description:
      'Wat deze werkruimte elke maand voor single sign-on betaalt. Een lopende add-on krijgt de nieuwe prijs vanaf de volgende factuur.',
    mode: 'Prijs',
    list: 'Catalogusprijs',
    custom: 'Eigen prijs',
    customHint: 'Een maandprijs alleen voor deze werkruimte.',
    free: 'Gratis',
    freeHint: 'Single sign-on staat meteen aan, zonder kosten.',
    amount: 'Bedrag per maand',
    amountPlaceholder: 'Bijvoorbeeld 75 of 49.50',
    currency: 'Valuta',
    currencyHint: 'Gebruik de valuta waarin Stripe deze klant factureert. Hun catalogusprijs is in {currency}.',
    invalidAmount: 'Voer een bedrag in zoals 75 of 49.50.',
    zeroAmount: 'Voer een bedrag boven 0 in, of kies Gratis.',
    tooHigh: 'Het bedrag mag niet hoger zijn dan {max} per maand.',
    switchOn: 'SSO nu aanzetten (belast de opgeslagen kaart)',
    switchOnHint:
      'Start de add-on tegen deze prijs en belast de standaardbetaalmethode van de klant. Laat dit uit om alleen de prijs op te slaan; die geldt dan zodra de werkruimte SSO toevoegt in haar Instellingen.',
    liveReprice: 'De lopende add-on krijgt deze prijs vanaf de volgende factuur. Er wordt niets naar rato verrekend.',
    liveCancel: 'De lopende add-on wordt direct opgezegd met een tegoed naar rato. Single sign-on blijft aan.',
    planIncludes: 'Het plan bevat single sign-on al. Een prijs die je hier opslaat geldt alleen als de werkruimte overstapt naar een plan zonder SSO.',
    partner: 'Deze werkruimte wordt door haar partner gefactureerd, dus hier is alleen Gratis beschikbaar.',
    submit: 'Prijs opslaan',
    noCard:
      'De klant heeft geen kaart om te belasten. Sla de prijs op zonder SSO aan te zetten, of vraag hen een betaalmethode toe te voegen.',
    successCreated: 'SSO-add-on gestart.',
    successRepriced: 'Prijs opgeslagen. De add-on krijgt die vanaf de volgende factuur.',
    successCanceled: 'Single sign-on is nu gratis en de betaalde add-on is opgezegd.',
    successSaved: 'SSO-prijs opgeslagen.',
  },
  revoke: {
    title: 'Single sign-on intrekken',
    description:
      'Wist de eigen prijs en beëindigt de betaalde add-on. Tenzij het plan het bevat, verliest de werkruimte single sign-on zodra niets het meer dekt.',
    periodEnd: 'Aan het einde van de periode',
    periodEndHint: 'Single sign-on blijft werken tot {date}, daarna stopt de add-on.',
    immediately: 'Direct',
    immediatelyHint: 'Beëindigt de add-on nu, met een tegoed naar rato.',
    noAddon: 'Er loopt geen add-on, dus dit wist alleen de prijs.',
    freeGrantEnds: 'De gratis toekenning stopt direct.',
    submit: 'SSO intrekken',
    successCanceled: 'SSO-add-on opgezegd.',
    successScheduled: 'De SSO-add-on stopt aan het einde van de periode.',
    successCleared: 'SSO-prijs gewist.',
  },
  disable: {
    title: 'De SSO-verbinding uitzetten',
    description:
      'De noodschakelaar voor een identiteitsprovider die mensen buitensluit: Clerk stuurt de leden van het domein er niet meer heen. De configuratie blijft bewaard, en de beheerder van de werkruimte kan de verbinding in Instellingen weer aanzetten zodra de provider is hersteld.',
    submit: 'Verbinding uitzetten',
    success: 'SSO-verbinding uitgezet.',
    alreadyOff: 'De SSO-verbinding stond al uit.',
  },
  activity: {
    'sso.grant': 'SSO-prijs ingesteld',
    'sso.revoke': 'SSO ingetrokken',
    'sso.connection.disable': 'SSO-verbinding uitgezet',
  },
};

/**
 * Same locale source as the rest of the console (`getLocale()`, the i18n
 * cookie); anything but `nl` reads English.
 */
export function ssoCopy(): SsoCopy {
  return getLocale() === 'nl' ? nl : en;
}

/** The label of an `sso.*` admin audit action, or null for any other action. */
export function ssoActionLabel(action: string): string | null {
  const labels: Record<string, string> = ssoCopy().activity;
  return labels[action] ?? null;
}

export const ssoCopyByLocale = { en, nl } as const;
