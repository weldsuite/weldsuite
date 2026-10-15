/**
 * Shared fixtures of the fiscal document tests. Not a test file: it has no
 * `.test.ts` suffix.
 */

export const SAMPLE_KEY = '41261012345678000123550010000000221923094166';

/** A received NF-e (nfeProc) of a Lucro Presumido supplier: two items (ICMS, IPI, PIS/COFINS; Simples CSOSN), freight, installments. */
export const SAMPLE_NFE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe" versao="4.00">
  <NFe>
    <infNFe Id="NFe${SAMPLE_KEY}" versao="4.00">
      <ide>
        <cUF>41</cUF><natOp>Venda de mercadoria</natOp><mod>55</mod><serie>001</serie><nNF>000000022</nNF>
        <dhEmi>2026-10-10T09:30:00-03:00</dhEmi><tpNF>1</tpNF>
      </ide>
      <emit>
        <CNPJ>12345678000123</CNPJ><xNome>Fornecedor &amp; Filhos Ltda</xNome><xFant>Fornecedor</xFant>
        <enderEmit><xLgr>Rua A</xLgr><UF>PR</UF></enderEmit><IE>1234567890</IE><CRT>3</CRT>
      </emit>
      <dest><CNPJ>99887766000155</CNPJ><xNome>Comprador SA</xNome></dest>
      <det nItem="1">
        <prod>
          <cProd>SKU-1</cProd><xProd>Parafuso sextavado</xProd><NCM>73181500</NCM><CFOP>6102</CFOP>
          <uCom>CX</uCom><qCom>10.0000</qCom><vUnCom>25.0000000000</vUnCom><vProd>250.00</vProd><vDesc>10.00</vDesc>
        </prod>
        <imposto>
          <ICMS><ICMS00><orig>0</orig><CST>00</CST><modBC>3</modBC><vBC>240.00</vBC><pICMS>12.0000</pICMS><vICMS>28.80</vICMS></ICMS00></ICMS>
          <IPI><cEnq>999</cEnq><IPITrib><CST>50</CST><vBC>240.00</vBC><pIPI>5.0000</pIPI><vIPI>12.00</vIPI></IPITrib></IPI>
          <PIS><PISAliq><CST>01</CST><vBC>211.20</vBC><pPIS>1.6500</pPIS><vPIS>3.48</vPIS></PISAliq></PIS>
          <COFINS><COFINSAliq><CST>01</CST><vBC>211.20</vBC><pCOFINS>7.6000</pCOFINS><vCOFINS>16.05</vCOFINS></COFINSAliq></COFINS>
        </imposto>
      </det>
      <det nItem="2">
        <prod>
          <cProd>SKU-2</cProd><xProd><![CDATA[Porca <M8>]]></xProd><NCM>73181600</NCM><CFOP>6102</CFOP>
          <uCom>UN</uCom><qCom>5.0000</qCom><vUnCom>10.0000000000</vUnCom><vProd>50.00</vProd>
        </prod>
        <imposto>
          <ICMS><ICMSSN102><orig>1</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS>
          <PIS><PISNT><CST>07</CST></PISNT></PIS>
          <COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>
        </imposto>
      </det>
      <total><ICMSTot><vBC>240.00</vBC><vICMS>28.80</vICMS><vST>0.00</vST><vProd>300.00</vProd><vFrete>15.00</vFrete><vSeg>0.00</vSeg><vDesc>10.00</vDesc><vIPI>12.00</vIPI><vOutro>0.00</vOutro><vNF>317.00</vNF></ICMSTot></total>
      <cobr><dup><nDup>001</nDup><dVenc>2026-11-10</dVenc><vDup>158.50</vDup></dup><dup><nDup>002</nDup><dVenc>2026-12-10</dVenc><vDup>158.50</vDup></dup></cobr>
      <pag><detPag><tPag>15</tPag><vPag>317.00</vPag></detPag></pag>
    </infNFe>
  </NFe>
  <protNFe versao="4.00"><infProt><chNFe>${SAMPLE_KEY}</chNFe><nProt>141260000000001</nProt><cStat>100</cStat></infProt></protNFe>
</nfeProc>`;
