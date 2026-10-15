/**
 * Português do Brasil: parcial. Só o que o WeldBooks Brasil precisa fica aqui;
 * o resto vem do inglês (`withEnglishFallback`).
 */
export const accounting = {
  // Palavras que mudam por jurisdição. As chaves são os códigos de terminologia do adaptador.
  terminology: {
    tax: { vat: 'IVA', gst: 'GST', sales_tax: 'Sales tax', tributos: 'Tributos' },
    taxRate: { vat: 'Alíquota de IVA', gst: 'Alíquota de GST', sales_tax: 'Alíquota de sales tax', tributos: 'Perfil tributário' },
    noTax: { vat: 'Sem IVA', gst: 'Sem GST', sales_tax: 'Sem sales tax', tributos: 'Sem tributos' },
    taxReturns: { vat: 'Declarações de IVA', gst: 'Declarações de GST', sales_tax: 'Sales tax', tributos: 'Apuração de tributos' },
    taxId: { vat_number: 'Número de IVA', gstin: 'GSTIN', cnpj: 'CNPJ', ein: 'EIN', tax_id: 'Identificação fiscal' },
    registrationId: {
      kvk: 'Número da Câmara de Comércio (KvK)',
      kbo: 'Número de empresa (KBO/BCE)',
      pan: 'PAN',
      company_number: 'Número de registro da empresa',
      state_id: 'Inscrição estadual',
      ie: 'Inscrição Estadual (IE)',
    },
    supplier: { supplier: 'Fornecedor', vendor: 'Fornecedor' },
    suppliers: { supplier: 'Fornecedores', vendor: 'Fornecedores' },
    supplierAddress: { supplier: 'Endereço do fornecedor', vendor: 'Endereço do fornecedor' },
    customerAndSupplier: { supplier: 'Cliente + fornecedor', vendor: 'Cliente + fornecedor' },
    creditNote: { credit_note: 'Nota de crédito', credit_memo: 'Nota de crédito' },
    creditNotes: { credit_note: 'Notas de crédito', credit_memo: 'Notas de crédito' },
  },

  // Campos de endereço compartilhados (components/address/address-fields)
  addressFields: {
    line1: 'Endereço',
    line1Placeholder: 'Rua e número',
    line1PlaceholderBr: 'Rua e número, ex.: Rua das Flores, 123',
    line2: 'Complemento',
    line2Placeholder: 'Apartamento, sala, conjunto (opcional)',
    neighborhood: 'Bairro',
    city: 'Cidade',
    state: 'Estado',
    selectState: 'Selecione um estado',
    postalCode: 'Código postal',
    cep: 'CEP',
    country: 'País',
    selectCountry: 'Selecione um país',
    noCountry: 'Sem país',
  },

  // Tipos de entidade jurídica
  entityTypes: {
    mei: 'MEI (microempreendedor individual)',
    ei: 'EI (empresário individual)',
    slu: 'SLU (sociedade limitada unipessoal)',
    ltda: 'Ltda (sociedade limitada)',
    sa: 'S.A. (sociedade anônima)',
  },

  entities: {
    displayNamePlaceholders: { BR: 'WeldCorp Ltda' } as Record<string, string>,
    legalNamePlaceholders: { BR: 'WeldCorp Tecnologia Ltda' } as Record<string, string>,
  },
};
