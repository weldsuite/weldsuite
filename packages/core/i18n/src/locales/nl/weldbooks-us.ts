/**
 * WeldBooks VS-boekhouding, per onderdeel opgesplitst (zie en/weldbooks-us.ts).
 */
import { weldbooksUsSetup } from './weldbooks-us-setup';
import { weldbooksUsReports } from './weldbooks-us-reports';
import { weldbooksUsBanking } from './weldbooks-us-banking';
import { weldbooksUsBankFeeds } from './weldbooks-us-bank-feeds';
import { weldbooksUsSalesTax } from './weldbooks-us-sales-tax';
import { weldbooksUs1099 } from './weldbooks-us-form1099';
import { weldbooksUsPayments } from './weldbooks-us-payments';
import { weldbooksUsAssets } from './weldbooks-us-assets';

export const weldbooksUs = {
  setup: weldbooksUsSetup,
  reports: weldbooksUsReports,
  banking: weldbooksUsBanking,
  bankFeeds: weldbooksUsBankFeeds,
  salesTax: weldbooksUsSalesTax,
  form1099: weldbooksUs1099,
  payments: weldbooksUsPayments,
  assets: weldbooksUsAssets,
};
