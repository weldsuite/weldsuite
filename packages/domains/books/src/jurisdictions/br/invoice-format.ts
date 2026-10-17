import type { InvoiceLabels, InvoiceRequirements } from '../types';

const ptLabels: InvoiceLabels = {
  invoice: 'Fatura',
  creditNote: 'Nota de crédito',
  invoiceNumber: 'Número',
  date: 'Data de emissão',
  dueDate: 'Vencimento',
  from: 'Emitente',
  billTo: 'Destinatário',
  shipTo: 'Local de entrega',
  description: 'Descrição',
  quantity: 'Qtd.',
  unitPrice: 'Valor unitário',
  tax: 'Tributos',
  amount: 'Valor',
  subtotal: 'Valor dos produtos/serviços',
  discount: 'Desconto',
  taxTotal: 'Tributos',
  total: 'Valor líquido',
  amountPaid: 'Pago',
  balanceDue: 'Saldo a pagar',
  paymentInstructions: 'Dados para pagamento',
  vatNumberLabel: 'CNPJ',
  registrationLabel: 'Inscrição estadual',
  draftNotice: 'Rascunho: sem valor fiscal',
  reference: 'Referência',
  notes: 'Observações',
  terms: 'Condições',
  ncm: 'NCM',
  cfop: 'CFOP',
  includedTaxes: 'Tributos incluídos no preço',
  withholdings: 'Retenções',
  netAmount: 'Valor líquido a receber',
  informationalTaxes: 'CBS/IBS (informativo, ano-teste 2026)',
  fiscalDocument: 'Documento fiscal',
  accessKey: 'Chave de acesso',
  pixPayment: 'Pague com Pix',
};

const enLabels: InvoiceLabels = {
  invoice: 'Invoice',
  creditNote: 'Credit note',
  invoiceNumber: 'Number',
  date: 'Issue date',
  dueDate: 'Due date',
  from: 'From',
  billTo: 'Bill to',
  shipTo: 'Ship to',
  description: 'Description',
  quantity: 'Qty',
  unitPrice: 'Unit price',
  tax: 'Taxes',
  amount: 'Amount',
  subtotal: 'Goods/services',
  discount: 'Discount',
  taxTotal: 'Taxes',
  total: 'Net amount',
  amountPaid: 'Paid',
  balanceDue: 'Balance due',
  paymentInstructions: 'Payment details',
  vatNumberLabel: 'CNPJ',
  registrationLabel: 'State registration (IE)',
  draftNotice: 'Draft: no fiscal value',
  ncm: 'NCM',
  cfop: 'CFOP',
  includedTaxes: 'Taxes included in the price',
  withholdings: 'Withholdings',
  netAmount: 'Net amount receivable',
  informationalTaxes: 'CBS/IBS (informational, 2026 test year)',
  fiscalDocument: 'Fiscal document',
  accessKey: 'Access key',
  pixPayment: 'Pay with Pix',
};

/**
 * Statements an ME/EPP in the Simples Nacional must print on its documents
 * (LC 123/2006 art. 23 and Resolução CGSN 140/2018 art. 59).
 */
export const BR_NOTICE_SIMPLES =
  'Documento emitido por ME ou EPP optante pelo Simples Nacional. Não gera direito a crédito fiscal de IPI.';
export const BR_NOTICE_MEI = 'Documento emitido por MEI optante pelo SIMEI.';
export const BR_NOTICE_EXPORT = 'Operação de exportação: não incidência de ICMS, IPI, PIS, COFINS e ISS.';
export const BR_NOTICE_CBS_IBS_2026 =
  'CBS e IBS destacados apenas para fins informativos (ano-teste de 2026, LC 214/2025).';
/**
 * WeldBooks' own invoice is a commercial document (fatura). The fiscal
 * document is the NF-e / NFS-e authorised by SEFAZ or the municipality.
 */
export const BR_NOTICE_NOT_FISCAL =
  'Este documento não substitui a nota fiscal eletrônica (NF-e / NFS-e).';

export function getBrInvoiceRequirements(locale = 'pt-BR'): InvoiceRequirements {
  return {
    formatInvoiceNumber: (prefix, value, padding) => `${prefix}${String(value).padStart(padding, '0')}`,
    defaultPadding: 6,
    requiredFields: ['vatNumber', 'address'],
    recommendedFields: ['registrationNumber'],
    labels: locale.toLowerCase().startsWith('pt') ? ptLabels : enLabels,
  };
}
