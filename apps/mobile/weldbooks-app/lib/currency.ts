const currencyFormatters: Record<string, Intl.NumberFormat> = {};

export function formatCurrency(amount: number | string, currency = 'EUR', locale = 'nl-NL'): string {
  const key = `${currency}-${locale}`;
  if (!currencyFormatters[key]) {
    currencyFormatters[key] = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  }

  const numericAmount = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(numericAmount)) return '€0.00';

  return currencyFormatters[key].format(numericAmount);
}

export function formatCompactCurrency(amount: number | string, currency = 'EUR'): string {
  const numericAmount = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(numericAmount)) return '€0';

  if (numericAmount >= 1_000_000) {
    return `€${(numericAmount / 1_000_000).toFixed(1)}M`;
  }
  if (numericAmount >= 1_000) {
    return `€${(numericAmount / 1_000).toFixed(1)}K`;
  }
  return formatCurrency(numericAmount, currency);
}

export function parseAmount(value: string): number {
  // Handle European format (1.234,56) and US format (1,234.56)
  const cleaned = value.replace(/[^\d.,-]/g, '');
  // If contains comma as decimal separator
  if (cleaned.includes(',') && (!cleaned.includes('.') || cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.'))) {
    return parseFloat(cleaned.replace(/\./g, '').replace(',', '.'));
  }
  return parseFloat(cleaned.replace(/,/g, ''));
}
