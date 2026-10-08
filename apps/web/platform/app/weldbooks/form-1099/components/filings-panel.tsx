import { Link, useNavigate } from '@tanstack/react-router';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { usePermissions } from '@weldsuite/permissions/react';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@weldsuite/ui/components/card';
import { useCreateForm1099Filing, useForm1099Filings } from '@/hooks/queries/use-weldbooks-1099-queries';
import type { Form1099Filing, Form1099Summary } from '@/lib/api/domains/weldbooks-1099';
import { useI18n } from '@/lib/i18n/provider';
import type { Form1099Type } from '@/lib/weldbooks/form-1099';
import { useWeldbooksFormat } from '@/lib/weldbooks/use-weldbooks-format';
import { FORM_TYPES, vendorsForForm } from '../form-1099-model';
import { FilingStatusBadge } from './filing-status-badge';

interface FilingsPanelProps {
  year: number;
  summary: Form1099Summary | undefined;
}

/** The id of the filing that already exists, from the 409 a second create answers with. */
export function existingFilingId(err: unknown): string | null {
  const body = (err as { body?: { error?: { details?: { filingId?: unknown } } } } | null)?.body;
  const id = body?.error?.details?.filingId;
  return typeof id === 'string' ? id : null;
}

function FilingCard({
  form,
  year,
  filing,
  recipients,
}: Readonly<{ form: Form1099Type; year: number; filing: Form1099Filing | undefined; recipients: number }>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.form1099.filings;
  const { can } = usePermissions();
  const { formatMoney, formatDate } = useWeldbooksFormat();
  const navigate = useNavigate();
  const create = useCreateForm1099Filing();

  const start = async () => {
    try {
      const detail = await create.mutateAsync({ taxYear: year, formType: form });
      navigate({ to: '/weldbooks/form-1099/filings/$id', params: { id: detail.filing.id } });
    } catch (err) {
      const existing = existingFilingId(err);
      if (existing) {
        navigate({ to: '/weldbooks/form-1099/filings/$id', params: { id: existing } });
        return;
      }
      toast.error(tf.createFailed, { description: err instanceof Error ? err.message : undefined });
    }
  };

  return (
    <Card data-testid={`filing-card-${form}`}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {t.weldbooksUs.form1099.forms[form]} · {year}
          {filing ? <FilingStatusBadge status={filing.status} /> : null}
        </CardTitle>
        <CardDescription>{tf.formHelp[form]}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {filing ? (
          <>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">{tf.recipients}</dt>
                <dd className="tabular-nums">{filing.lineCount}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{tf.reported}</dt>
                <dd className="tabular-nums">{formatMoney(filing.totals.amount)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{tf.withheld}</dt>
                <dd className="tabular-nums">{formatMoney(filing.totals.withheld)}</dd>
              </div>
              {filing.filedAt ? (
                <div>
                  <dt className="text-xs text-muted-foreground">{tf.filedOn}</dt>
                  <dd>
                    {formatDate(filing.filedAt)}
                    {filing.confirmationNumber ? <span className="block text-xs text-muted-foreground">{filing.confirmationNumber}</span> : null}
                  </dd>
                </div>
              ) : null}
            </dl>
            <Button asChild>
              <Link to="/weldbooks/form-1099/filings/$id" params={{ id: filing.id }}>
                {tf.open}
              </Link>
            </Button>
          </>
        ) : recipients === 0 ? (
          <p className="text-sm text-muted-foreground">{tf.nobody.replace('{form}', t.weldbooksUs.form1099.forms[form])}</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {tf.wouldGoOn.replace('{n}', String(recipients)).replace('{form}', t.weldbooksUs.form1099.forms[form])}
            </p>
            {can('taxes:create') ? (
              <Button type="button" onClick={() => void start()} disabled={create.isPending}>
                {create.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden /> : null}
                {tf.create.replace('{form}', t.weldbooksUs.form1099.forms[form])}
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">{tf.needsPermission}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** A filing per form for the year (the 1099-NEC and the 1099-MISC are filed separately), and the filings of other years. */
export function FilingsPanel({ year, summary }: Readonly<FilingsPanelProps>) {
  const { t } = useI18n();
  const tf = t.weldbooksUs.form1099.filings;
  const { formatDate } = useWeldbooksFormat();
  const query = useForm1099Filings();
  const all = query.data ?? [];
  const thisYear = all.filter((f) => f.taxYear === year);
  const others = all.filter((f) => f.taxYear !== year).sort((a, b) => b.taxYear - a.taxYear || a.formType.localeCompare(b.formType));

  if (query.isLoading) return <p className="text-sm text-muted-foreground">{tf.loading}</p>;
  if (query.isError) {
    return (
      <div className="space-y-2" role="alert">
        <p className="text-sm text-destructive">{tf.loadFailed}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>
          {tf.retry}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {FORM_TYPES.map((form) => (
          <FilingCard
            key={form}
            form={form}
            year={year}
            filing={thisYear.find((f) => f.formType === form)}
            recipients={summary ? vendorsForForm(summary, form).length : 0}
          />
        ))}
      </div>

      {others.length > 0 ? (
        <section aria-labelledby="other-filings">
          <h2 id="other-filings" className="mb-2 text-sm font-medium">
            {tf.otherYears}
          </h2>
          <ul className="divide-y rounded-md border">
            {others.map((filing) => (
              <li key={filing.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                <span className="flex flex-wrap items-center gap-2">
                  <Link to="/weldbooks/form-1099/filings/$id" params={{ id: filing.id }} className="font-medium hover:underline">
                    {t.weldbooksUs.form1099.forms[filing.formType]} · {filing.taxYear}
                  </Link>
                  <FilingStatusBadge status={filing.status} />
                </span>
                <span className="text-xs text-muted-foreground">
                  {tf.recipientsCount.replace('{n}', String(filing.lineCount))}
                  {filing.filedAt ? ` · ${tf.filedOnDate.replace('{date}', formatDate(filing.filedAt))}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
