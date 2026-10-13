import { useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription } from '@weldsuite/ui/components/alert';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@weldsuite/ui/components/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import { PageLoader } from '@/components/page-loader';
import { useGstWorksheet } from '@/hooks/queries/use-weldbooks-gst-queries';
import type { GstHeads, GstOutwardTotals, GstWarning, GstWorksheet } from '@/lib/api/domains/weldbooks-gst';
import { useI18n } from '@/lib/i18n/provider';
import { placeOfSupplyName } from '@/lib/weldbooks/gst';
import { monthPeriod, previousMonthPeriod, quarterPeriod, type GstPeriod } from '@/lib/weldbooks/gst-periods';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';

type Texts = ReturnType<typeof useI18n>['t']['weldbooksIn']['gstReturn'];

const NUM = 'text-right tabular-nums';

/** India GST return: the GSTR-3B and GSTR-1 summary of a period, worked out from the tax ledger. A worksheet, never filed. */
export default function GstReturnPage() {
  const { t } = useI18n();
  const tg = t.weldbooksIn.gstReturn;
  const { today, entity } = useWeldbooksFormat();
  const [period, setPeriod] = useState<GstPeriod>(() => monthPeriod(today()));
  const worksheet = useGstWorksheet(period);

  const setPreset = (next: GstPeriod) => setPeriod(next);
  const gstin = entity?.taxIdentifiers?.vatNumber;

  return (
    <div className="p-6 space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">{tg.title}</h1>
        <p className="text-sm text-muted-foreground max-w-3xl">{tg.description}</p>
        {gstin && (
          <p className="text-sm text-muted-foreground">
            {tg.gstin}: <span className="font-medium text-foreground">{gstin}</span>
            {worksheet.data?.entityStateCode ? ` · ${tg.stateCode} ${worksheet.data.entityStateCode}` : ''}
          </p>
        )}
      </div>

      <Card>
        <CardContent className="flex flex-wrap items-end gap-4 pt-6">
          <div className="space-y-2">
            <Label htmlFor="gst-period-start">{tg.periodStart}</Label>
            <Input
              id="gst-period-start"
              type="date"
              value={period.periodStart}
              onChange={(e) => setPeriod({ ...period, periodStart: e.target.value })}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="gst-period-end">{tg.periodEnd}</Label>
            <Input
              id="gst-period-end"
              type="date"
              value={period.periodEnd}
              onChange={(e) => setPeriod({ ...period, periodEnd: e.target.value })}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setPreset(monthPeriod(today()))}>
              {tg.thisMonth}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPreset(previousMonthPeriod(today()))}>
              {tg.lastMonth}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setPreset(quarterPeriod(today()))}>
              {tg.thisQuarter}
            </Button>
          </div>
        </CardContent>
      </Card>

      {worksheet.isLoading && <PageLoader fullScreen={false} />}

      {worksheet.isError && (
        <Alert variant="destructive" data-testid="gst-load-error">
          <AlertTriangle />
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>{worksheet.error instanceof Error && worksheet.error.message ? worksheet.error.message : tg.loadFailed}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void worksheet.refetch()}>
              {tg.retry}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {worksheet.data && <Worksheet sheet={worksheet.data} texts={tg} />}

      <p className="text-xs text-muted-foreground">{tg.worksheetOnly}</p>
    </div>
  );
}

function Worksheet({ sheet, texts: tg }: Readonly<{ sheet: GstWorksheet; texts: Texts }>) {
  const { formatMoney: fmt } = useWeldbooksFormat();
  return (
    <div className="space-y-4">
      <Warnings warnings={sheet.warnings} texts={tg} money={fmt} />
      <Tabs defaultValue="gstr3b">
        <TabsList>
          <TabsTrigger value="gstr3b">{tg.tabs.gstr3b}</TabsTrigger>
          <TabsTrigger value="gstr1">{tg.tabs.gstr1}</TabsTrigger>
          <TabsTrigger value="hsn">{tg.tabs.hsn}</TabsTrigger>
        </TabsList>
        <TabsContent value="gstr3b" className="space-y-6">
          <Gstr3b sheet={sheet} texts={tg} />
        </TabsContent>
        <TabsContent value="gstr1" className="space-y-6">
          <Gstr1 sheet={sheet} texts={tg} />
        </TabsContent>
        <TabsContent value="hsn">
          <Hsn sheet={sheet} texts={tg} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Warnings({
  warnings,
  texts: tg,
  money,
}: Readonly<{ warnings: GstWarning[]; texts: Texts; money: (value: number) => string }>) {
  if (warnings.length === 0) return null;
  const message = (w: GstWarning): string =>
    tg.warnings[w.code].replace('{count}', String(w.count)).replace('{amount}', money(w.amount ?? 0));
  return (
    <div className="space-y-2" data-testid="gst-warnings">
      {warnings.map((w) => (
        <Alert key={w.code}>
          <AlertTriangle />
          <AlertDescription>{message(w)}</AlertDescription>
        </Alert>
      ))}
    </div>
  );
}

function Section({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">{children}</CardContent>
    </Card>
  );
}

const sum = (h: GstHeads): number => h.igst + h.cgst + h.sgst + h.cess;

// ---------------------------------------------------------------------------
// GSTR-3B
// ---------------------------------------------------------------------------

function Gstr3b({ sheet, texts: tg }: Readonly<{ sheet: GstWorksheet; texts: Texts }>) {
  const { formatMoney: fmt } = useWeldbooksFormat();
  const { t } = useI18n();
  const outside = t.weldbooksIn.gst.placeOfSupplyOutside;
  const b = sheet.gstr3b;
  const c = tg.columns;
  const t3 = tg.gstr3b;

  const outwardRows: Array<[string, GstOutwardTotals | { taxableValue: number }]> = [
    [t3.outwardTaxable, b.outwardTaxable],
    [t3.zeroRated, b.zeroRated],
    [t3.nilExempt, b.nilExempt],
    [t3.reverseCharge, b.reverseCharge],
  ];
  const heads = (row: GstOutwardTotals | { taxableValue: number }) => ('igst' in row ? row : null);

  const head = (label: string, value: GstHeads, key: string) => (
    <TableRow key={key}>
      <TableCell>{label}</TableCell>
      <TableCell className={NUM}>{fmt(value.igst)}</TableCell>
      <TableCell className={NUM}>{fmt(value.cgst)}</TableCell>
      <TableCell className={NUM}>{fmt(value.sgst)}</TableCell>
      <TableCell className={NUM}>{fmt(value.cess)}</TableCell>
      <TableCell className={`${NUM} font-medium`}>{fmt(sum(value))}</TableCell>
    </TableRow>
  );

  const headHeader = (first: string) => (
    <TableHeader>
      <TableRow>
        <TableHead>{first}</TableHead>
        <TableHead className="text-right">{c.igst}</TableHead>
        <TableHead className="text-right">{c.cgst}</TableHead>
        <TableHead className="text-right">{c.sgst}</TableHead>
        <TableHead className="text-right">{c.cess}</TableHead>
        <TableHead className="text-right">{c.total}</TableHead>
      </TableRow>
    </TableHeader>
  );

  const pay = b.payment;
  return (
    <>
      <Section title={t3.outwardTitle}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead />
              <TableHead className="text-right">{c.taxableValue}</TableHead>
              <TableHead className="text-right">{c.igst}</TableHead>
              <TableHead className="text-right">{c.cgst}</TableHead>
              <TableHead className="text-right">{c.sgst}</TableHead>
              <TableHead className="text-right">{c.cess}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {outwardRows.map(([label, row]) => {
              const h = heads(row);
              return (
                <TableRow key={label}>
                  <TableCell>{label}</TableCell>
                  <TableCell className={NUM}>{fmt(row.taxableValue)}</TableCell>
                  <TableCell className={NUM}>{h ? fmt(h.igst) : '—'}</TableCell>
                  <TableCell className={NUM}>{h ? fmt(h.cgst) : '—'}</TableCell>
                  <TableCell className={NUM}>{h ? fmt(h.sgst) : '—'}</TableCell>
                  <TableCell className={NUM}>{h ? fmt(h.cess) : '—'}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Section>

      <Section title={t3.interStateTitle}>
        {b.interStateUnregistered.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t3.interStateEmpty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{c.placeOfSupply}</TableHead>
                <TableHead className="text-right">{c.taxableValue}</TableHead>
                <TableHead className="text-right">{c.igst}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {b.interStateUnregistered.map((row) => (
                <TableRow key={row.placeOfSupply ?? 'none'}>
                  <TableCell>{placeOfSupplyName(row.placeOfSupply, outside) || tg.unknownPlace}</TableCell>
                  <TableCell className={NUM}>{fmt(row.taxable)}</TableCell>
                  <TableCell className={NUM}>{fmt(row.igst)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title={t3.itcTitle}>
        <Table>
          {headHeader('')}
          <TableBody>
            {head(t3.itcReverseCharge, b.itc.reverseCharge, 'rcm')}
            {head(t3.itcOther, b.itc.other, 'other')}
            {head(t3.itcTotal, b.itc.total, 'total')}
          </TableBody>
        </Table>
      </Section>

      <Section title={t3.paymentTitle}>
        <Table>
          {headHeader('')}
          <TableBody>
            {head(t3.liability, pay.liability, 'liability')}
            {head(t3.reverseChargeLiability, pay.reverseChargeLiability, 'rcm-liability')}
            {head(t3.creditUsed, pay.itcUtilisation.creditUsed, 'used')}
            {head(t3.netPayable, pay.netPayable, 'net')}
            {head(t3.carryForward, pay.itcUtilisation.carryForward, 'carry')}
          </TableBody>
        </Table>
        <p className="mt-3 flex items-center justify-between rounded-md bg-muted/50 px-3 py-2 text-sm font-semibold">
          <span>{t3.totalNetPayable}</span>
          <span className="tabular-nums" data-testid="gst-total-net-payable">{fmt(pay.totalNetPayable)}</span>
        </p>
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------
// GSTR-1
// ---------------------------------------------------------------------------

function Gstr1({ sheet, texts: tg }: Readonly<{ sheet: GstWorksheet; texts: Texts }>) {
  const { formatMoney: fmt, formatDate } = useWeldbooksFormat();
  const { t } = useI18n();
  const outside = t.weldbooksIn.gst.placeOfSupplyOutside;
  const g = sheet.gstr1;
  const c = tg.columns;
  const t1 = tg.gstr1;
  const place = (code: string | null) => placeOfSupplyName(code, outside) || tg.unknownPlace;

  const taxHeads = (
    <>
      <TableHead className="text-right">{c.taxableValue}</TableHead>
      <TableHead className="text-right">{c.igst}</TableHead>
      <TableHead className="text-right">{c.cgst}</TableHead>
      <TableHead className="text-right">{c.sgst}</TableHead>
    </>
  );
  const taxCells = (v: { taxable: number; igst: number; cgst: number; sgst: number }) => (
    <>
      <TableCell className={NUM}>{fmt(v.taxable)}</TableCell>
      <TableCell className={NUM}>{fmt(v.igst)}</TableCell>
      <TableCell className={NUM}>{fmt(v.cgst)}</TableCell>
      <TableCell className={NUM}>{fmt(v.sgst)}</TableCell>
    </>
  );

  const nilLabel = (category: 'nil_rated' | 'exempt') => (category === 'exempt' ? t1.exempt : t1.nilRated);

  return (
    <>
      <Section title={t1.b2bTitle}>
        {g.b2b.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t1.b2bEmpty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{c.gstin}</TableHead>
                <TableHead>{c.invoice}</TableHead>
                <TableHead>{c.date}</TableHead>
                <TableHead>{c.placeOfSupply}</TableHead>
                <TableHead className="text-right">{c.rate}</TableHead>
                {taxHeads}
              </TableRow>
            </TableHeader>
            <TableBody>
              {g.b2b.map((party) => (
                <PartyRows key={party.gstin} party={party} place={place} formatDate={formatDate} taxCells={taxCells} />
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title={t1.b2cLargeTitle}>
        {g.b2cLarge.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t1.b2cEmpty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{c.invoice}</TableHead>
                <TableHead>{c.date}</TableHead>
                <TableHead>{c.placeOfSupply}</TableHead>
                <TableHead className="text-right">{c.rate}</TableHead>
                {taxHeads}
              </TableRow>
            </TableHeader>
            <TableBody>
              {g.b2cLarge.map((line) => (
                <TableRow key={`${line.documentId}-${line.slabRate}`}>
                  <TableCell>{line.number}</TableCell>
                  <TableCell>{formatDate(line.date)}</TableCell>
                  <TableCell>{place(line.placeOfSupply)}</TableCell>
                  <TableCell className={NUM}>{line.slabRate}%</TableCell>
                  {taxCells(line)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title={t1.b2cSmallTitle}>
        {g.b2cSmall.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t1.b2cEmpty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{c.placeOfSupply}</TableHead>
                <TableHead className="text-right">{c.rate}</TableHead>
                {taxHeads}
              </TableRow>
            </TableHeader>
            <TableBody>
              {g.b2cSmall.map((line) => (
                <TableRow key={`${line.placeOfSupply ?? ''}-${line.slabRate}`}>
                  <TableCell>{place(line.placeOfSupply)}</TableCell>
                  <TableCell className={NUM}>{line.slabRate}%</TableCell>
                  {taxCells(line)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title={t1.exportsTitle}>
        {g.exports.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t1.exportsEmpty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{c.invoice}</TableHead>
                <TableHead>{c.date}</TableHead>
                <TableHead className="text-right">{c.value}</TableHead>
                <TableHead className="text-right">{c.taxableValue}</TableHead>
                <TableHead className="text-right">{c.igst}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {g.exports.map((row) => (
                <TableRow key={row.documentId}>
                  <TableCell>{row.number}</TableCell>
                  <TableCell>{formatDate(row.date)}</TableCell>
                  <TableCell className={NUM}>{fmt(row.value)}</TableCell>
                  <TableCell className={NUM}>{fmt(row.taxable)}</TableCell>
                  <TableCell className={NUM}>{fmt(row.igst)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      {g.nilExempt.length > 0 && (
        <Section title={t1.nilExemptTitle}>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{c.category}</TableHead>
                <TableHead className="text-right">{c.intraRegistered}</TableHead>
                <TableHead className="text-right">{c.intraUnregistered}</TableHead>
                <TableHead className="text-right">{c.interRegistered}</TableHead>
                <TableHead className="text-right">{c.interUnregistered}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {g.nilExempt.map((row) => (
                <TableRow key={row.category}>
                  <TableCell>{nilLabel(row.category)}</TableCell>
                  <TableCell className={NUM}>{fmt(row.intraRegistered)}</TableCell>
                  <TableCell className={NUM}>{fmt(row.intraUnregistered)}</TableCell>
                  <TableCell className={NUM}>{fmt(row.interRegistered)}</TableCell>
                  <TableCell className={NUM}>{fmt(row.interUnregistered)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Section>
      )}

      <Section title={t1.creditNotesTitle}>
        {g.creditNotes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t1.creditNotesEmpty}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{c.gstin}</TableHead>
                <TableHead>{c.invoice}</TableHead>
                <TableHead>{c.originalInvoice}</TableHead>
                <TableHead>{c.date}</TableHead>
                <TableHead className="text-right">{c.rate}</TableHead>
                {taxHeads}
              </TableRow>
            </TableHeader>
            <TableBody>
              {g.creditNotes.map((line) => (
                <TableRow key={`${line.documentId}-${line.slabRate}`}>
                  <TableCell>{line.gstin ?? '—'}</TableCell>
                  <TableCell>{line.number}</TableCell>
                  <TableCell>{line.originalNumber ?? '—'}</TableCell>
                  <TableCell>{formatDate(line.date)}</TableCell>
                  <TableCell className={NUM}>{line.slabRate}%</TableCell>
                  {taxCells(line)}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Section>

      <Section title={t1.totalsTitle}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="text-right">{c.taxableValue}</TableHead>
              <TableHead className="text-right">{c.igst}</TableHead>
              <TableHead className="text-right">{c.cgst}</TableHead>
              <TableHead className="text-right">{c.sgst}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell className={NUM}>{fmt(g.totals.taxableValue)}</TableCell>
              <TableCell className={NUM}>{fmt(g.totals.igst)}</TableCell>
              <TableCell className={NUM}>{fmt(g.totals.cgst)}</TableCell>
              <TableCell className={NUM}>{fmt(g.totals.sgst)}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Section>
    </>
  );
}

function PartyRows({
  party,
  place,
  formatDate,
  taxCells,
}: Readonly<{
  party: GstWorksheet['gstr1']['b2b'][number];
  place: (code: string | null) => string;
  formatDate: (value: string) => string;
  taxCells: (v: { taxable: number; igst: number; cgst: number; sgst: number }) => ReactNode;
}>) {
  return (
    <>
      {party.lines.map((line, index) => (
        <TableRow key={`${line.documentId}-${line.slabRate}`}>
          <TableCell>
            {index === 0 ? (
              <div>
                <div className="font-medium">{party.gstin}</div>
                <div className="text-xs text-muted-foreground">{party.name}</div>
              </div>
            ) : null}
          </TableCell>
          <TableCell>{line.number}</TableCell>
          <TableCell>{formatDate(line.date)}</TableCell>
          <TableCell>{place(line.placeOfSupply)}</TableCell>
          <TableCell className={NUM}>{line.slabRate}%</TableCell>
          {taxCells(line)}
        </TableRow>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// HSN/SAC summary
// ---------------------------------------------------------------------------

function Hsn({ sheet, texts: tg }: Readonly<{ sheet: GstWorksheet; texts: Texts }>) {
  const { formatMoney: fmt, formatNumber } = useWeldbooksFormat();
  const rows = useMemo(() => sheet.gstr1.hsn, [sheet.gstr1.hsn]);
  const c = tg.columns;
  return (
    <Section title={tg.hsn.title}>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{tg.hsn.empty}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{c.hsnSac}</TableHead>
              <TableHead>{c.unit}</TableHead>
              <TableHead className="text-right">{c.rate}</TableHead>
              <TableHead className="text-right">{c.quantity}</TableHead>
              <TableHead className="text-right">{c.taxableValue}</TableHead>
              <TableHead className="text-right">{c.igst}</TableHead>
              <TableHead className="text-right">{c.cgst}</TableHead>
              <TableHead className="text-right">{c.sgst}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.hsnSac ?? ''}-${row.unit ?? ''}-${row.slabRate}`}>
                <TableCell className="font-medium">{row.hsnSac ?? tg.hsn.notSpecified}</TableCell>
                <TableCell>{row.unit ?? '—'}</TableCell>
                <TableCell className={NUM}>{row.slabRate}%</TableCell>
                <TableCell className={NUM}>{formatNumber(row.quantity)}</TableCell>
                <TableCell className={NUM}>{fmt(row.taxable)}</TableCell>
                <TableCell className={NUM}>{fmt(row.igst)}</TableCell>
                <TableCell className={NUM}>{fmt(row.cgst)}</TableCell>
                <TableCell className={NUM}>{fmt(row.sgst)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}
