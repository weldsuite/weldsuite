import { describe, expect, it } from 'vitest';
import { parseBankFile } from './index';
import { parseOfx, parseOfxAmount, parseOfxDate } from './ofx';

/** OFX 1.x: SGML, a plain-text header and leaf elements without closing tags. */
const SGML_CHECKING = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20260201093000.000[-5:EST]
<LANGUAGE>ENG
<FI>
<ORG>Example Bank
<FID>1234
</FI>
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>021000021
<ACCTID>000123456789
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>20260101120000.000[-5:EST]
<DTEND>20260131120000.000[-5:EST]
<STMTTRN>
<TRNTYPE>CHECK
<DTPOSTED>20260105120000.000[-5:EST]
<TRNAMT>-1250.00
<FITID>2026010501
<CHECKNUM>1042
<NAME>OFFICE LANDLORD LLC
<MEMO>Rent January
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEP
<DTPOSTED>20260112000000
<TRNAMT>4800.50
<FITID>2026011201
<NAME>ACME CORP
<MEMO>ACH CREDIT INV 2001
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260131235959[-8:PST]
<TRNAMT>-89.99
<FITID>2026013101
<NAME>ADOBE INC
<MEMO>ADOBE INC
</STMTTRN>
<STMTTRN>
<TRNTYPE>SRVCHG
<DTPOSTED>20260131
<TRNAMT>-12
<FITID>2026013102
<NAME>MONTHLY SERVICE FEE
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>3448.51
<DTASOF>20260131120000.000[-5:EST]
</LEDGERBAL>
<AVAILBAL>
<BALAMT>3398.51
<DTASOF>20260131120000.000[-5:EST]
</AVAILBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;

const XML_CHECKING = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?OFX OFXHEADER="200" VERSION="202" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX>
  <SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE><SEVERITY>INFO</SEVERITY></STATUS><DTSERVER>20260301</DTSERVER><LANGUAGE>ENG</LANGUAGE></SONRS></SIGNONMSGSRSV1>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <TRNUID>0</TRNUID>
      <STMTRS>
        <CURDEF>USD</CURDEF>
        <BANKACCTFROM><BANKID>322271627</BANKID><ACCTID>9876543210</ACCTID><ACCTTYPE>SAVINGS</ACCTTYPE></BANKACCTFROM>
        <BANKTRANLIST>
          <DTSTART>20260201</DTSTART><DTEND>20260228</DTEND>
          <STMTTRN>
            <TRNTYPE>INT</TRNTYPE><DTPOSTED>20260228</DTPOSTED><TRNAMT>12.34</TRNAMT><FITID>INT0228</FITID>
            <NAME>INTEREST PAID</NAME><MEMO></MEMO>
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20260210</DTPOSTED><TRNAMT>-45,50</TRNAMT><FITID>D0210</FITID>
            <NAME>Smith &amp; Sons Plumbing</NAME><MEMO>Invoice #77 &lt;urgent&gt;</MEMO>
          </STMTTRN>
        </BANKTRANLIST>
        <LEDGERBAL><BALAMT>1012.34</BALAMT><DTASOF>20260228</DTASOF></LEDGERBAL>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>`;

/** A QuickBooks Web Connect file: OFX with an Intuit bank id; purchases are negative on a card. */
const QBO_CARD = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<DTSERVER>20260301
<LANGUAGE>ENG
<FI>
<ORG>Example Card Services
<FID>3000
</FI>
<INTU.BID>3000
</SONRS>
</SIGNONMSGSRSV1>
<CREDITCARDMSGSRSV1>
<CCSTMTTRNRS>
<TRNUID>1
<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<CCSTMTRS>
<CURDEF>USD
<CCACCTFROM>
<ACCTID>4111111111111111
</CCACCTFROM>
<BANKTRANLIST>
<DTSTART>20260201
<DTEND>20260228
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260203
<TRNAMT>-64.20
<FITID>CC0203A
<NAME>STAPLES 0123
<MEMO>OFFICE SUPPLIES
</STMTTRN>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260209
<TRNAMT>-1299.00
<FITID>CC0209A
<NAME>DELL MARKETING
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260215
<TRNAMT>-20.00
<FITID>CC0215A
<NAME>STAPLES 0123
<MEMO>RETURN
</STMTTRN>
<STMTTRN>
<TRNTYPE>PAYMENT
<DTPOSTED>20260220
<TRNAMT>1500.00
<FITID>CC0220A
<NAME>ONLINE PAYMENT THANK YOU
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>-1.7
<DTASOF>20260228
</LEDGERBAL>
</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>
`;

describe('OFX dates and amounts', () => {
  it('reads the calendar date and drops the time and zone', () => {
    expect(parseOfxDate('20260115120000.000[-5:EST]')).toBe('2026-01-15');
    expect(parseOfxDate('20260131235959[-8:PST]')).toBe('2026-01-31');
    expect(parseOfxDate('20260229')).toBe('2026-02-29'); // range-checked only for month and day
    expect(parseOfxDate('20261301')).toBeNull();
    expect(parseOfxDate('')).toBeNull();
  });

  it('reads signed amounts with a point or a comma', () => {
    expect(parseOfxAmount('-1250.00')).toBe(-1250);
    expect(parseOfxAmount('+12')).toBe(12);
    expect(parseOfxAmount('45,50')).toBe(45.5);
    expect(parseOfxAmount('abc')).toBeNull();
  });
});

describe('OFX 1.x (SGML, no closing tags)', () => {
  const result = parseOfx(SGML_CHECKING);

  it('reads the account, period and balances', () => {
    expect(result.errors).toEqual([]);
    expect(result.format).toBe('ofx');
    expect(result.account).toEqual({
      routingNumber: '021000021',
      accountNumber: '000123456789',
      accountType: 'checking',
      currency: 'USD',
    });
    expect(result.closingBalance).toBe(3448.51);
    expect(result.availableBalance).toBe(3398.51);
    expect(result.balanceDate).toBe('2026-01-31');
    expect(result.dateRange).toEqual({ from: '2026-01-05', to: '2026-01-31' });
  });

  it('reads every transaction with its FITID, check number and unshifted date', () => {
    expect(result.transactions).toHaveLength(4);
    const [check, deposit, adobe, fee] = result.transactions;
    expect(check).toMatchObject({
      date: '2026-01-05',
      amount: -1250,
      externalId: '2026010501',
      checkNumber: '1042',
      counterpartyName: 'OFFICE LANDLORD LLC',
      description: 'OFFICE LANDLORD LLC - Rent January',
      transactionCode: 'CHECK',
    });
    expect(deposit).toMatchObject({ date: '2026-01-12', amount: 4800.5, externalId: '2026011201' });
    // 23:59:59 at -8:00 is still the 31st: the zone is never applied.
    expect(adobe.date).toBe('2026-01-31');
    // A memo that repeats the name is not repeated in the description.
    expect(adobe.description).toBe('ADOBE INC');
    expect(fee).toMatchObject({ amount: -12, description: 'MONTHLY SERVICE FEE' });
  });
});

describe('OFX 2.x (XML)', () => {
  const result = parseOfx(XML_CHECKING);

  it('reads entities, empty leaves and comma decimals', () => {
    expect(result.errors).toEqual([]);
    expect(result.account).toMatchObject({ routingNumber: '322271627', accountNumber: '9876543210', accountType: 'savings' });
    expect(result.transactions).toHaveLength(2);
    const [interest, plumber] = result.transactions;
    expect(interest).toMatchObject({ amount: 12.34, description: 'INTEREST PAID', externalId: 'INT0228' });
    expect(plumber).toMatchObject({
      amount: -45.5,
      counterpartyName: 'Smith & Sons Plumbing',
      description: 'Smith & Sons Plumbing - Invoice #77 <urgent>',
    });
  });
});

describe('QBO / QFX', () => {
  it('is the OFX parser with the dialect taken from the file extension', () => {
    const qbo = parseBankFile(QBO_CARD, undefined, { fileName: 'activity.QBO' });
    expect(qbo.format).toBe('qbo');
    const qfx = parseBankFile(SGML_CHECKING, undefined, { fileName: 'export.qfx' });
    expect(qfx.format).toBe('qfx');
    expect(parseBankFile(SGML_CHECKING).format).toBe('ofx');
  });

  it('reads a credit card statement: purchases negative, payment positive, balance owed negative', () => {
    const result = parseBankFile(QBO_CARD, undefined, { fileName: 'card.qbo' });
    expect(result.errors).toEqual([]);
    expect(result.account).toMatchObject({ accountNumber: '4111111111111111', accountType: 'credit_card', currency: 'USD' });
    expect(result.transactions.map((t) => t.amount)).toEqual([-64.2, -1299, -20, 1500]);
    // Even a "CREDIT" line keeps the file's sign: here the card was charged -20.00.
    expect(result.transactions[2]).toMatchObject({ transactionCode: 'CREDIT', amount: -20 });
    expect(result.closingBalance).toBe(-1.7);
  });
});

describe('OFX edge cases', () => {
  it('keeps two lines that share a FITID and gives lines without one a stable id', () => {
    const body = (fitid: string) =>
      `<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105<TRNAMT>-5.00${fitid}<NAME>COFFEE SHOP</STMTTRN>`;
    const file = (inner: string) => `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>1<ACCTID>2222<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>${inner}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

    const shared = parseOfx(file(body('<FITID>X1') + body('<FITID>X1')));
    expect(shared.transactions.map((t) => t.externalId)).toEqual(['X1', 'X1#2']);

    const first = parseOfx(file(body('') + body('')));
    const again = parseOfx(file(body('') + body('')));
    const ids = first.transactions.map((t) => t.externalId);
    expect(ids[0]).toMatch(/^ofx:/);
    expect(ids[1]).toBe(`${ids[0]}#2`);
    expect(again.transactions.map((t) => t.externalId)).toEqual(ids);
  });

  it('reports lines without a date or amount and keeps the rest', () => {
    const result = parseOfx(
      '<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>1<ACCTID>2222<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST>' +
        '<STMTTRN><TRNTYPE>DEBIT<TRNAMT>-5.00<FITID>A1</STMTTRN>' +
        '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105<TRNAMT>-6.00<FITID>A2</STMTTRN>' +
        '</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>',
    );
    expect(result.transactions.map((t) => t.externalId)).toEqual(['A2']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toMatch(/DTPOSTED/);
  });

  it('picks the account out of a multi-account file by its last four digits', () => {
    const section = (acct: string, fitid: string) =>
      `<STMTTRNRS><STMTRS><CURDEF>USD<BANKACCTFROM><BANKID>1<ACCTID>${acct}<ACCTTYPE>CHECKING</BANKACCTFROM><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260105<TRNAMT>-5.00<FITID>${fitid}<NAME>X</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS>`;
    const file = `<OFX><BANKMSGSRSV1>${section('1111111111', 'F1')}${section('2222222222', 'F2')}</BANKMSGSRSV1></OFX>`;

    expect(parseOfx(file, { accountLast4: '2222' }).transactions.map((t) => t.externalId)).toEqual(['F2']);
    const none = parseOfx(file);
    expect(none.transactions).toEqual([]);
    expect(none.errors[0].message).toMatch(/holds 2 accounts/);
    expect(none.accounts).toHaveLength(2);
  });

  it('rejects text that is not OFX', () => {
    expect(parseOfx('Date,Description\n').errors[0].message).toMatch(/No <OFX>/);
  });
});
