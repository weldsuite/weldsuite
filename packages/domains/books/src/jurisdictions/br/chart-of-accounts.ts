import type { ChartOfAccountsTemplateRow, SystemAccountRole } from '../types';

type Row = ChartOfAccountsTemplateRow;

function system(
  code: string,
  name: string,
  type: Row['type'],
  subtype: string,
  normalSide: Row['normalSide'],
  systemRole: SystemAccountRole,
): Row {
  return { code, name, type, subtype, normalSide, isSystemAccount: true, systemRole };
}

/**
 * Brazilian chart of accounts (plano de contas) seeded when a BR entity is
 * created. It follows the usual structure of the plano referencial: 1 Ativo,
 * 2 Passivo e Patrimônio Líquido, 3 Receitas, 4 Custos e Despesas, with dotted
 * codes. Names are Portuguese to match the entity's default locale (pt-BR).
 *
 * Every tax has its own payable (a recolher), its own recoverable account for
 * credits on purchases (a recuperar) and, for taxes inside the price, its own
 * revenue deduction, so the DRE shows receita bruta → deduções → receita
 * líquida. Withholdings have a receivable for what customers kept back
 * (a compensar) and a payable for what we keep back from suppliers.
 */
export const brChartOfAccounts: ChartOfAccountsTemplateRow[] = [
  // 1 Ativo circulante
  { code: '1.1.1.01', name: 'Caixa', type: 'asset', subtype: 'cash', normalSide: 'debit' },
  { code: '1.1.1.02', name: 'Bancos conta movimento', type: 'asset', subtype: 'bank', normalSide: 'debit' },
  { code: '1.1.1.03', name: 'Aplicações financeiras de liquidez imediata', type: 'asset', subtype: 'current_assets', normalSide: 'debit' },
  system('1.1.1.04', 'Numerário em trânsito', 'asset', 'current_assets', 'debit', 'undeposited_funds'),
  system('1.1.2.01', 'Clientes', 'asset', 'accounts_receivable', 'debit', 'accounts_receivable'),
  { code: '1.1.2.02', name: '(-) Perdas estimadas com créditos de liquidação duvidosa', type: 'asset', subtype: 'accounts_receivable', normalSide: 'credit' },
  { code: '1.1.3.01', name: 'Estoque de mercadorias', type: 'asset', subtype: 'current_assets', normalSide: 'debit' },
  { code: '1.1.3.02', name: 'Estoque de matérias-primas', type: 'asset', subtype: 'current_assets', normalSide: 'debit' },
  system('1.1.4.01', 'ICMS a recuperar', 'asset', 'tax', 'debit', 'tax_recoverable_icms'),
  system('1.1.4.02', 'IPI a recuperar', 'asset', 'tax', 'debit', 'tax_recoverable_ipi'),
  system('1.1.4.03', 'PIS a recuperar', 'asset', 'tax', 'debit', 'tax_recoverable_pis'),
  system('1.1.4.04', 'COFINS a recuperar', 'asset', 'tax', 'debit', 'tax_recoverable_cofins'),
  system('1.1.4.05', 'IRRF a compensar', 'asset', 'tax', 'debit', 'withheld_receivable_irrf'),
  system('1.1.4.06', 'PIS retido a compensar', 'asset', 'tax', 'debit', 'withheld_receivable_pis'),
  system('1.1.4.07', 'COFINS retida a compensar', 'asset', 'tax', 'debit', 'withheld_receivable_cofins'),
  system('1.1.4.08', 'CSLL retida a compensar', 'asset', 'tax', 'debit', 'withheld_receivable_csll'),
  system('1.1.4.09', 'INSS retido a compensar', 'asset', 'tax', 'debit', 'withheld_receivable_inss'),
  system('1.1.4.10', 'Outros tributos a recuperar', 'asset', 'tax', 'debit', 'tax_input'),
  system('1.1.4.11', 'CBS a recuperar', 'asset', 'tax', 'debit', 'tax_recoverable_cbs'),
  system('1.1.4.12', 'IBS a recuperar', 'asset', 'tax', 'debit', 'tax_recoverable_ibs'),
  { code: '1.1.5.01', name: 'Adiantamentos a fornecedores', type: 'asset', subtype: 'current_assets', normalSide: 'debit' },
  { code: '1.1.5.02', name: 'Despesas antecipadas', type: 'asset', subtype: 'current_assets', normalSide: 'debit' },

  // 1.2 Ativo não circulante
  system('1.2.3.01', 'Máquinas e equipamentos', 'asset', 'fixed_assets', 'debit', 'fixed_assets'),
  { code: '1.2.3.02', name: 'Móveis e utensílios', type: 'asset', subtype: 'fixed_assets', normalSide: 'debit' },
  { code: '1.2.3.03', name: 'Veículos', type: 'asset', subtype: 'fixed_assets', normalSide: 'debit' },
  { code: '1.2.3.04', name: 'Computadores e periféricos', type: 'asset', subtype: 'fixed_assets', normalSide: 'debit' },
  system('1.2.3.90', '(-) Depreciação acumulada', 'asset', 'fixed_assets', 'credit', 'accumulated_depreciation'),
  { code: '1.2.4.01', name: 'Intangível', type: 'asset', subtype: 'fixed_assets', normalSide: 'debit' },

  // 2.1 Passivo circulante
  system('2.1.1.01', 'Fornecedores', 'liability', 'accounts_payable', 'credit', 'accounts_payable'),
  system('2.1.1.02', 'Cartões de crédito a pagar', 'liability', 'accounts_payable', 'credit', 'credit_card_payable'),
  system('2.1.2.01', 'Salários e encargos a pagar', 'liability', 'accounts_payable', 'credit', 'payroll_liabilities'),
  { code: '2.1.2.02', name: 'INSS a recolher', type: 'liability', subtype: 'tax', normalSide: 'credit' },
  { code: '2.1.2.03', name: 'FGTS a recolher', type: 'liability', subtype: 'tax', normalSide: 'credit' },
  system('2.1.3.01', 'ICMS a recolher', 'liability', 'tax', 'credit', 'tax_payable_icms'),
  system('2.1.3.02', 'IPI a recolher', 'liability', 'tax', 'credit', 'tax_payable_ipi'),
  system('2.1.3.03', 'PIS a recolher', 'liability', 'tax', 'credit', 'tax_payable_pis'),
  system('2.1.3.04', 'COFINS a recolher', 'liability', 'tax', 'credit', 'tax_payable_cofins'),
  system('2.1.3.05', 'ISS a recolher', 'liability', 'tax', 'credit', 'tax_payable_iss'),
  system('2.1.3.06', 'Simples Nacional a recolher', 'liability', 'tax', 'credit', 'tax_payable_simples'),
  system('2.1.3.07', 'IRPJ a recolher', 'liability', 'tax', 'credit', 'tax_payable_irpj'),
  system('2.1.3.08', 'CSLL a recolher', 'liability', 'tax', 'credit', 'tax_payable_csll'),
  system('2.1.3.09', 'Outros tributos a recolher', 'liability', 'tax', 'credit', 'tax_payable'),
  system('2.1.3.10', 'CBS a recolher', 'liability', 'tax', 'credit', 'tax_payable_cbs'),
  system('2.1.3.11', 'IBS a recolher', 'liability', 'tax', 'credit', 'tax_payable_ibs'),
  system('2.1.4.01', 'IRRF retido a recolher', 'liability', 'tax', 'credit', 'withholding_payable_irrf'),
  system('2.1.4.02', 'PIS/COFINS/CSLL retidos a recolher', 'liability', 'tax', 'credit', 'withholding_payable_csrf'),
  system('2.1.4.03', 'INSS retido a recolher', 'liability', 'tax', 'credit', 'withholding_payable_inss'),
  system('2.1.4.04', 'ISS retido a recolher', 'liability', 'tax', 'credit', 'withholding_payable_iss'),
  { code: '2.1.5.01', name: 'Empréstimos e financiamentos', type: 'liability', subtype: 'accounts_payable', normalSide: 'credit' },
  { code: '2.1.9.01', name: 'Adiantamentos de clientes', type: 'liability', subtype: 'accounts_payable', normalSide: 'credit' },
  { code: '2.2.1.01', name: 'Empréstimos e financiamentos de longo prazo', type: 'liability', subtype: 'accounts_payable', normalSide: 'credit' },

  // 2.3 Patrimônio líquido
  system('2.3.1.01', 'Capital social', 'equity', 'capital', 'credit', 'owner_equity'),
  { code: '2.3.2.01', name: 'Reservas de lucros', type: 'equity', subtype: 'retained_earnings', normalSide: 'credit' },
  system('2.3.3.01', 'Lucros ou prejuízos acumulados', 'equity', 'retained_earnings', 'credit', 'retained_earnings'),
  system('2.3.4.01', 'Saldos de abertura', 'equity', 'capital', 'credit', 'opening_balance_equity'),
  system('2.3.9.01', 'Lucros distribuídos e retiradas', 'equity', 'capital', 'debit', 'owner_draws'),

  // 3 Receitas
  { code: '3.1.1.01', name: 'Receita de venda de mercadorias', type: 'revenue', subtype: 'sales', normalSide: 'credit' },
  system('3.1.1.02', 'Receita de prestação de serviços', 'revenue', 'service_revenue', 'credit', 'sales_revenue'),
  { code: '3.1.1.03', name: 'Receita de venda de produtos de fabricação própria', type: 'revenue', subtype: 'sales', normalSide: 'credit' },
  { code: '3.1.1.04', name: 'Receita de exportação', type: 'revenue', subtype: 'sales', normalSide: 'credit' },
  system('3.1.2.01', '(-) ICMS sobre vendas', 'revenue', 'sales', 'debit', 'revenue_deduction_icms'),
  system('3.1.2.02', '(-) PIS sobre faturamento', 'revenue', 'sales', 'debit', 'revenue_deduction_pis'),
  system('3.1.2.03', '(-) COFINS sobre faturamento', 'revenue', 'sales', 'debit', 'revenue_deduction_cofins'),
  system('3.1.2.04', '(-) ISS sobre serviços', 'revenue', 'sales', 'debit', 'revenue_deduction_iss'),
  system('3.1.2.05', '(-) Simples Nacional', 'revenue', 'sales', 'debit', 'revenue_deduction_simples'),
  { code: '3.1.2.06', name: '(-) Devoluções e cancelamentos', type: 'revenue', subtype: 'sales', normalSide: 'debit' },
  { code: '3.1.2.07', name: '(-) Descontos incondicionais', type: 'revenue', subtype: 'sales', normalSide: 'debit' },
  { code: '3.2.1.01', name: 'Receitas financeiras', type: 'revenue', subtype: 'other_income', normalSide: 'credit' },
  system('3.2.1.02', 'Variação cambial ativa', 'revenue', 'other_income', 'credit', 'realized_fx_gain'),
  { code: '3.2.1.03', name: 'Outras receitas operacionais', type: 'revenue', subtype: 'other_income', normalSide: 'credit' },

  // 4 Custos e despesas
  { code: '4.1.1.01', name: 'Custo das mercadorias vendidas', type: 'expense', subtype: 'cost_of_goods_sold', normalSide: 'debit' },
  { code: '4.1.1.02', name: 'Custo dos serviços prestados', type: 'expense', subtype: 'cost_of_goods_sold', normalSide: 'debit' },
  { code: '4.1.1.03', name: 'Compras de mercadorias', type: 'expense', subtype: 'cost_of_goods_sold', normalSide: 'debit' },
  system('4.2.1.01', 'Salários e ordenados', 'expense', 'operating_expense', 'debit', 'payroll_wages_expense'),
  system('4.2.1.02', 'Encargos sociais (INSS e FGTS)', 'expense', 'operating_expense', 'debit', 'payroll_tax_expense'),
  { code: '4.2.1.03', name: 'Pró-labore', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4.2.1.04', name: 'Benefícios a empregados', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4.2.2.01', name: 'Aluguéis e condomínios', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4.2.2.02', name: 'Energia elétrica, água e telefone', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4.2.2.03', name: 'Material de escritório e consumo', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4.2.2.04', name: 'Serviços prestados por pessoa jurídica', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4.2.2.05', name: 'Honorários contábeis e advocatícios', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4.2.2.06', name: 'Propaganda e publicidade', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4.2.2.07', name: 'Viagens e estadias', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  { code: '4.2.2.08', name: 'Softwares e assinaturas', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  system('4.2.2.09', 'Depreciação e amortização', 'expense', 'operating_expense', 'debit', 'depreciation_expense'),
  system('4.2.2.10', 'Perdas com créditos de clientes', 'expense', 'operating_expense', 'debit', 'bad_debt_expense'),
  system('4.2.2.11', 'Multas e juros sobre tributos', 'expense', 'operating_expense', 'debit', 'tax_penalties_interest'),
  { code: '4.2.2.12', name: 'Taxas e contribuições', type: 'expense', subtype: 'operating_expense', normalSide: 'debit' },
  system('4.2.2.99', 'Despesas gerais', 'expense', 'operating_expense', 'debit', 'general_expense'),
  { code: '4.3.1.01', name: 'Despesas bancárias e tarifas', type: 'expense', subtype: 'other_expense', normalSide: 'debit' },
  { code: '4.3.1.02', name: 'Juros passivos', type: 'expense', subtype: 'other_expense', normalSide: 'debit' },
  system('4.3.1.03', 'Variação cambial passiva', 'expense', 'other_expense', 'debit', 'realized_fx_loss'),
  system('4.3.1.04', 'Arredondamentos', 'expense', 'other_expense', 'debit', 'rounding'),
  system('4.3.1.05', 'Resultado na alienação de imobilizado', 'expense', 'other_expense', 'debit', 'gain_loss_on_disposal'),
  system('4.9.1.01', 'Imposto de renda (IRPJ)', 'expense', 'other_expense', 'debit', 'income_tax_expense'),
  system('4.9.1.02', 'Contribuição social (CSLL)', 'expense', 'other_expense', 'debit', 'social_contribution_expense'),
];
