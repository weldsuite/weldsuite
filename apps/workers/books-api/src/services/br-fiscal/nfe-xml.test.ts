import { describe, expect, it } from 'vitest';
import { parseNfeXml, parseXml, XmlParseError } from './nfe-xml';
import { SAMPLE_KEY, SAMPLE_NFE_XML } from './test-fixtures';

describe('parseXml', () => {
  it('reads elements, attributes, entities, CDATA and ignores prefixes and comments', () => {
    const root = parseXml('<?xml version="1.0"?><!-- c --><a:root xmlns:a="x" id="1"><a:t>1 &lt; 2 &amp; &#65;</a:t><u><![CDATA[<raw>]]></u><e/></a:root>');
    expect(root.name).toBe('root');
    expect(root.attrs.id).toBe('1');
    expect(root.children.map((c) => c.name)).toEqual(['t', 'u', 'e']);
    expect(root.children[0].text).toBe('1 < 2 & A');
    expect(root.children[1].text).toBe('<raw>');
  });

  it('rejects unbalanced and empty documents', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(XmlParseError);
    expect(() => parseXml('<a><b>')).toThrow(XmlParseError);
    expect(() => parseXml('   ')).toThrow(XmlParseError);
  });

  it('does not expand custom entities', () => {
    const root = parseXml('<!DOCTYPE a [<!ENTITY x "boom">]><a>&x;</a>');
    expect(root.text).toBe('&x;');
  });
});

describe('parseNfeXml', () => {
  it('extracts the key, issuer, header, totals and installments', () => {
    const nfe = parseNfeXml(SAMPLE_NFE_XML);
    expect(nfe.accessKey).toBe(SAMPLE_KEY);
    expect(nfe.issuer).toEqual({ taxId: '12345678000123', name: 'Fornecedor & Filhos Ltda', tradeName: 'Fornecedor', stateRegistration: '1234567890', uf: 'PR' });
    expect(nfe.recipient).toEqual({ taxId: '99887766000155', name: 'Comprador SA' });
    expect(nfe).toMatchObject({ number: '22', series: '1', issueDate: '2026-10-10', operation: 'Venda de mercadoria', total: 317, products: 300, discount: 10, freight: 15, ipi: 12, protocol: '141260000000001' });
    expect(nfe.installments).toEqual([
      { number: '001', dueDate: '2026-11-10', amount: 158.5 },
      { number: '002', dueDate: '2026-12-10', amount: 158.5 },
    ]);
    expect(nfe.payments).toEqual([{ method: '15', amount: 317 }]);
  });

  it('extracts items with their ICMS, IPI, PIS and COFINS', () => {
    const [first, second] = parseNfeXml(SAMPLE_NFE_XML).items;
    expect(first).toMatchObject({
      number: 1,
      code: 'SKU-1',
      description: 'Parafuso sextavado',
      ncm: '73181500',
      cfop: '6102',
      unit: 'CX',
      quantity: 10,
      unitPrice: 25,
      total: 250,
      discount: 10,
      origin: '0',
      icms: { cst: '00', base: 240, rate: 12, value: 28.8 },
      ipi: { cst: '50', base: 240, rate: 5, value: 12 },
      pis: { cst: '01', base: 211.2, rate: 1.65, value: 3.48 },
      cofins: { cst: '01', base: 211.2, rate: 7.6, value: 16.05 },
    });
    expect(second).toMatchObject({ description: 'Porca <M8>', origin: '1', icms: { cst: '102', value: 0 }, ipi: { cst: null, value: 0 } });
  });

  it('works on a bare NFe without the protocol wrapper', () => {
    const bare = SAMPLE_NFE_XML.replace(/<protNFe[\s\S]*<\/protNFe>/, '');
    expect(parseNfeXml(bare).protocol).toBeNull();
    expect(parseNfeXml(bare).accessKey).toBe(SAMPLE_KEY);
  });

  it('refuses something that is not an NF-e', () => {
    expect(() => parseNfeXml('<invoice><total>1</total></invoice>')).toThrow(/not an NF-e/);
    expect(() => parseNfeXml('<NFe><infNFe Id="NFe123"><ide/></infNFe></NFe>')).toThrow(/access key/);
  });
});
