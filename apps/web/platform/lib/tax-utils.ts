// Get available tax types with descriptions
export function getTaxTypes() {
  return [
    { value: 'SALES_TAX', label: 'Sales Tax', description: 'Tax on retail sales of goods and services' },
    { value: 'VAT', label: 'VAT', description: 'Value Added Tax - tax on consumption' },
    { value: 'GST', label: 'GST', description: 'Goods and Services Tax' },
    { value: 'INCOME_TAX', label: 'Income Tax', description: 'Tax on income' },
    { value: 'PAYROLL_TAX', label: 'Payroll Tax', description: 'Tax on wages and salaries' },
    { value: 'PROPERTY_TAX', label: 'Property Tax', description: 'Tax on real estate property' },
    { value: 'EXCISE_TAX', label: 'Excise Tax', description: 'Tax on specific goods like alcohol, tobacco' },
    { value: 'OTHER', label: 'Other', description: 'Other types of taxes' },
  ]
}