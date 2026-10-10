'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Pencil, Plus, Tags, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@weldsuite/ui/components/badge';
import { Button } from '@weldsuite/ui/components/button';
import { Card, CardContent } from '@weldsuite/ui/components/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog';
import { Input } from '@weldsuite/ui/components/input';
import { Label } from '@weldsuite/ui/components/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@weldsuite/ui/components/table';
import type { CountryPlanPrice, CountryPricing } from '@weldsuite/app-api-client/schemas/plan-country-pricing';
import { PageBody, PageContent, PageHeading } from '@/components/shell/admin-shell';
import { removeCountryPlanPricing, saveCountryPlanPricing } from '@/actions/plan-pricing';
import { adminPlanPricingCopy, fill } from '@/lib/i18n';
import {
  PRICED_PLAN_SLUGS,
  countryName,
  formatPlanPrice,
  toCountryPricingInput,
  type CountryPricingInput,
  type PricedPlanSlug,
} from '@/lib/plan-pricing';
import type { PlanPricingView } from '@/lib/plan-pricing-data';

/** Fixed UTC format so the server render and the client hydration agree. */
function formatTimestamp(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

function PriceCell({ price, currency }: Readonly<{ price: CountryPlanPrice | undefined; currency: string }>) {
  const copy = adminPlanPricingCopy();
  if (!price) return <span className="text-muted-foreground">{copy.onRequest}</span>;
  return (
    <div className="tabular-nums">
      <div>{fill(copy.perMonth, { price: formatPlanPrice(price.monthly, currency) })}</div>
      {price.annual !== null && (
        <div className="text-xs text-muted-foreground">
          {fill(copy.perMonthAnnual, { price: formatPlanPrice(price.annual, currency) })}
        </div>
      )}
    </div>
  );
}

export function PlanPricingList({
  pricing,
  canEdit,
}: Readonly<{ pricing: PlanPricingView; canEdit: boolean }>) {
  const router = useRouter();
  const copy = adminPlanPricingCopy();
  const [isMutating, startMutation] = useTransition();
  /** The dialog form; `editing` is the code it was opened for (`null` = adding a country). */
  const [form, setForm] = useState<CountryPricingInput | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const rows = Object.entries(pricing.config.countries).sort(([a], [b]) =>
    countryName(a).localeCompare(countryName(b)),
  );

  function openAdd() {
    setEditing(null);
    setForm(toCountryPricingInput('', null));
  }

  function openEdit(country: string, entry: CountryPricing) {
    setEditing(country);
    setForm(toCountryPricingInput(country, entry));
  }

  function setPlanField(plan: PricedPlanSlug, field: 'monthly' | 'annual', value: string) {
    setForm((f) => (f ? { ...f, plans: { ...f.plans, [plan]: { ...f.plans[plan], [field]: value } } } : f));
  }

  function save() {
    if (!form) return;
    startMutation(async () => {
      const result = await saveCountryPlanPricing(form, editing);
      if (result.ok) {
        toast.success(fill(copy.saved, { country: result.data.country }));
        setForm(null);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  function remove() {
    if (!removing) return;
    const country = removing;
    startMutation(async () => {
      const result = await removeCountryPlanPricing(country);
      if (result.ok) {
        toast.success(fill(copy.removed, { country }));
        setRemoving(null);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <PageContent>
      <PageBody className="space-y-6">
        <PageHeading
          title={
            <span className="flex items-center gap-2">
              <Tags className="h-6 w-6 text-primary" />
              {copy.title}
            </span>
          }
          description={copy.description}
          actions={
            canEdit ? (
              <Button onClick={openAdd} disabled={isMutating}>
                <Plus className="h-4 w-4" />
                {copy.addCountry}
              </Button>
            ) : undefined
          }
        />

        <Card className="py-4">
          <CardContent className="space-y-1 px-4 text-sm">
            <p>{copy.howItWorks}</p>
            <p className="text-xs text-muted-foreground">{copy.cacheNote}</p>
            <p className="text-xs text-muted-foreground">{copy.checkoutNote}</p>
          </CardContent>
        </Card>

        {rows.length === 0 ? (
          <Card className="py-10">
            <CardContent className="text-center text-sm text-muted-foreground">{copy.empty}</CardContent>
          </Card>
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{copy.columnCountry}</TableHead>
                  <TableHead>{copy.columnCurrency}</TableHead>
                  {PRICED_PLAN_SLUGS.map((plan) => (
                    <TableHead key={plan}>{copy.plans[plan]}</TableHead>
                  ))}
                  {canEdit && <TableHead className="w-24" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(([country, entry]) => (
                  <TableRow key={country}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="font-mono">
                          {country}
                        </Badge>
                        <span>{countryName(country)}</span>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-sm">{entry.currency}</TableCell>
                    {PRICED_PLAN_SLUGS.map((plan) => (
                      <TableCell key={plan}>
                        <PriceCell price={entry.plans[plan]} currency={entry.currency} />
                      </TableCell>
                    ))}
                    {canEdit && (
                      <TableCell>
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={fill(copy.editAria, { country })}
                            onClick={() => openEdit(country, entry)}
                            disabled={isMutating}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={fill(copy.removeAria, { country })}
                            onClick={() => setRemoving(country)}
                            disabled={isMutating}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          {pricing.updatedAt
            ? fill(copy.lastUpdated, {
                at: formatTimestamp(pricing.updatedAt),
                by: pricing.updatedBy ?? copy.unknownAdmin,
              })
            : copy.neverUpdated}
        </p>
      </PageBody>

      <Dialog open={form !== null} onOpenChange={(open) => !open && !isMutating && setForm(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? fill(copy.editTitle, { country: editing }) : copy.addTitle}</DialogTitle>
            <DialogDescription>{copy.dialogDescription}</DialogDescription>
          </DialogHeader>
          {form && (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="plan-pricing-country">{copy.countryLabel}</Label>
                  <Input
                    id="plan-pricing-country"
                    value={form.country}
                    maxLength={2}
                    placeholder="NL"
                    className="font-mono uppercase"
                    onChange={(e) => setForm({ ...form, country: e.target.value.toUpperCase() })}
                    disabled={isMutating}
                  />
                  <p className="text-xs text-muted-foreground">
                    {/^[A-Z]{2}$/.test(form.country) ? countryName(form.country) : copy.countryHelp}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="plan-pricing-currency">{copy.currencyLabel}</Label>
                  <Input
                    id="plan-pricing-currency"
                    value={form.currency}
                    maxLength={3}
                    placeholder="EUR"
                    className="font-mono uppercase"
                    onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
                    disabled={isMutating}
                  />
                  <p className="text-xs text-muted-foreground">{copy.currencyHelp}</p>
                </div>
              </div>

              <div className="space-y-3">
                {PRICED_PLAN_SLUGS.map((plan) => (
                  <div key={plan} className="grid items-end gap-3 sm:grid-cols-[8rem_1fr_1fr]">
                    <p className="pb-2 text-sm font-medium">{copy.plans[plan]}</p>
                    <div className="space-y-1">
                      <Label htmlFor={`plan-pricing-${plan}-monthly`} className="text-xs text-muted-foreground">
                        {copy.monthlyLabel}
                      </Label>
                      <Input
                        id={`plan-pricing-${plan}-monthly`}
                        inputMode="decimal"
                        placeholder={copy.onRequest}
                        value={form.plans[plan].monthly}
                        onChange={(e) => setPlanField(plan, 'monthly', e.target.value)}
                        disabled={isMutating}
                      />
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor={`plan-pricing-${plan}-annual`} className="text-xs text-muted-foreground">
                        {copy.annualLabel}
                      </Label>
                      <Input
                        id={`plan-pricing-${plan}-annual`}
                        inputMode="decimal"
                        placeholder={copy.annualPlaceholder}
                        value={form.plans[plan].annual}
                        onChange={(e) => setPlanField(plan, 'annual', e.target.value)}
                        disabled={isMutating}
                      />
                    </div>
                  </div>
                ))}
                <p className="text-xs text-muted-foreground">{copy.priceHelp}</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setForm(null)} disabled={isMutating}>
              {copy.cancel}
            </Button>
            <Button onClick={save} disabled={isMutating}>
              {isMutating && <Loader2 className="h-4 w-4 animate-spin" />}
              {copy.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removing !== null} onOpenChange={(open) => !open && !isMutating && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{fill(copy.removeTitle, { country: removing ?? '' })}</DialogTitle>
            <DialogDescription>{copy.removeDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)} disabled={isMutating}>
              {copy.cancel}
            </Button>
            <Button variant="destructive" onClick={remove} disabled={isMutating}>
              {isMutating && <Loader2 className="h-4 w-4 animate-spin" />}
              {copy.removeConfirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageContent>
  );
}
