/**
 * Settings → Apps → WeldBooks: the page that holds the settings WeldBooks
 * keeps outside the app (dimensions, US sales tax engine, vendor payments).
 */
export const weldbooksUsSettings = {
  title: 'WeldBooks',
  description: 'Dimensions, sales tax and vendor payments of a legal entity.',
  tabs: {
    dimensions: 'Dimensions',
    salesTax: 'Sales tax',
    paymentRuns: 'Payment runs',
  },
  entity: {
    label: 'Legal entity',
    hint: 'These settings apply to the selected legal entity.',
    none: 'WeldBooks is not enabled for any legal entity yet.',
  },
};
