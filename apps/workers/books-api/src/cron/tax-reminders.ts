/**
 * Daily tax reminders (docs/plans/weldbooks-us.md §5): part of the books-api
 * sweep, for every US accounting entity of a tenant the sweep visits.
 *
 *   sales tax returns   due in 7 days, due in 1 day (or today), overdue
 *   tax calendar        deadlines due in 14 days and in 3 days, not marked done
 *   certificates        exemption certificates expiring within 30 days (one notice for all new ones)
 *   nexus               a state newly past its economic nexus threshold (checked on Mondays)
 *
 * A reminder goes once per key and threshold: a marker is stored when it is
 * sent (`ReminderMarkers`, KV in production), so the daily run and a missed day
 * never repeat it. Windows are ranges, not exact days, so a missed run still
 * sends the reminder the next day. Recipients are the workspace owners and
 * admins. Delivery sits behind `ReminderNotifier` (see reminder-notifier.ts).
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { addMonths } from '@weldsuite/books-domain/us-compliance/dates';
import { schema, type Database } from '@weldsuite/worker-kit/db';
import { todayIn, type EntityRow } from '../services/sales-tax-returns/common';
import { loadAgencies } from '../services/sales-tax-returns/context';
import { buildPeriodRows, loadAgencyReturns } from '../services/sales-tax-returns/periods';
import { entityCalendar } from '../services/tax-calendar';
import { expiringCertificates } from '../services/sales-tax-reports';
import { nexusOverview } from '../services/nexus-monitor';

export const TAX_CENTER_PATH = '/weldbooks/tax';

export interface ReminderNotice {
  title: string;
  body: string;
  severity: 'info' | 'warning' | 'error';
  /** Path in the platform the notification opens. */
  actionUrl: string;
  entityType: string;
  entityId: string;
  /** What the reminder is about, for the notification payload (no personal data). */
  data?: Record<string, string>;
}

export interface ReminderNotifier {
  /** Delivers one notice to one workspace member. Throws on failure. */
  send(userId: string, notice: ReminderNotice): Promise<void>;
}

export interface ReminderMarkers {
  has(marker: string): Promise<boolean>;
  set(marker: string, ttlSeconds: number): Promise<void>;
}

/** Markers in the workspace KV namespace, one key per reminder and threshold. */
export function kvMarkers(kv: KVNamespace, orgId: string): ReminderMarkers {
  const name = (marker: string) => `books:reminder:${orgId}:${marker}`;
  return {
    async has(marker) {
      return (await kv.get(name(marker))) !== null;
    },
    async set(marker, ttlSeconds) {
      await kv.put(name(marker), '1', { expirationTtl: Math.max(60, ttlSeconds) });
    },
  };
}

/** Markers in memory (tests). */
export function memoryMarkers(): ReminderMarkers & { all: Map<string, number> } {
  const all = new Map<string, number>();
  return {
    all,
    async has(marker) {
      return all.has(marker);
    },
    async set(marker, ttlSeconds) {
      all.set(marker, ttlSeconds);
    },
  };
}

interface Candidate {
  /** `<key>:<threshold>`: the marker that keeps it from being sent twice. */
  marker: string;
  ttlDays: number;
  notice: ReminderNotice;
  /** Candidates of one group go out as a single notice. */
  group?: 'certificates';
}

const DAY_SECONDS = 24 * 60 * 60;

function inDays(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/** Sales tax returns of the entity's agencies that are due soon or overdue. */
async function salesTaxCandidates(db: Database, entity: EntityRow, today: string): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const agencies = (await loadAgencies(db, entity.id)).filter((a) => a.status === 'registered' || a.status === 'pending');
  for (const agency of agencies) {
    const returns = await loadAgencyReturns(db, entity.id, agency.id);
    // Periods that ended in the last six months; older ones are left to the overdue list of the UI.
    const periods = buildPeriodRows(agency, returns, addMonths(today, -6), today, today).filter((p) => p.unfiled);
    for (const p of periods) {
      const d = p.daysUntilDue;
      const threshold = d > 1 && d <= 7 ? '7d' : d >= 0 && d <= 1 ? '1d' : d < 0 && d >= -90 ? 'overdue' : null;
      if (!threshold) continue;
      const status = p.return ? `The return is ${p.return.status}.` : 'The return has not been started.';
      out.push({
        marker: `sales_tax:${agency.id}:${p.periodEnd}:${threshold}`,
        ttlDays: 150,
        notice: {
          title: threshold === 'overdue' ? `Sales tax return overdue: ${agency.name}` : `Sales tax return due ${inDays(d)}: ${agency.name}`,
          body: `The ${agency.stateCode} return for ${p.periodStart} to ${p.periodEnd} is due ${p.dueDate} (${inDays(d)}). ${status}`,
          severity: threshold === 'overdue' ? 'error' : 'warning',
          actionUrl: `${TAX_CENTER_PATH}/sales-tax`,
          entityType: 'sales_tax_agency',
          entityId: agency.id,
          data: { kind: 'sales_tax_due', agencyId: agency.id, periodEnd: p.periodEnd, dueDate: p.dueDate, threshold },
        },
      });
    }
  }
  return out;
}

/** Income tax, 1099 and other calendar deadlines (the sales tax ones are covered above). */
async function calendarCandidates(db: Database, entity: EntityRow, today: string, now: Date): Promise<Candidate[]> {
  const year = Number.parseInt(today.slice(0, 4), 10);
  const years = today.slice(5, 7) === '12' ? [year, year + 1] : [year];
  const out: Candidate[] = [];
  for (const y of years) {
    const calendar = await entityCalendar(db, entity, y, now);
    for (const item of calendar.items) {
      if (item.completed || item.informational || item.kind === 'sales_tax') continue;
      const d = item.daysUntilDue;
      const threshold = d > 3 && d <= 14 ? '14d' : d >= 0 && d <= 3 ? '3d' : null;
      if (!threshold) continue;
      out.push({
        marker: `calendar:${item.key}:${threshold}`,
        ttlDays: 60,
        notice: {
          title: `${item.title} is due ${inDays(d)}`,
          body: `Due ${item.dueDate}${item.note ? `. ${item.note}` : ''}`,
          severity: threshold === '3d' ? 'warning' : 'info',
          actionUrl: `${TAX_CENTER_PATH}/calendar`,
          entityType: 'tax_deadline',
          entityId: entity.id,
          data: { kind: 'tax_deadline', deadlineKey: item.key, dueDate: item.dueDate, threshold },
        },
      });
    }
  }
  return out;
}

async function certificateCandidates(db: Database, entity: EntityRow, now: Date): Promise<Candidate[]> {
  const report = await expiringCertificates(db, entity, { days: 30, now });
  return report.certificates
    .filter((c) => !c.expired)
    .map((c) => ({
      marker: `certificate:${c.certificateId}:${c.expiresOn}:30d`,
      ttlDays: 60,
      group: 'certificates' as const,
      notice: {
        title: 'Exemption certificate expiring',
        body: `${c.customerName ?? 'A customer'}${c.certificateNumber ? ` (${c.certificateNumber})` : ''} expires ${c.expiresOn} (${inDays(c.daysLeft)}).`,
        severity: 'warning' as const,
        actionUrl: `${TAX_CENTER_PATH}/certificates`,
        entityType: 'exemption_certificate',
        entityId: c.certificateId,
        data: { kind: 'certificate_expiring', certificateId: c.certificateId, expiresOn: c.expiresOn },
      },
    }));
}

async function nexusCandidates(db: Database, entity: EntityRow, now: Date): Promise<Candidate[]> {
  const overview = await nexusOverview(db, entity, undefined, now);
  return overview.rows
    .filter((r) => r.alert === 'register')
    .map((r) => ({
      marker: `nexus:${r.stateCode}:${r.exceededOn ?? overview.asOf}:exceeded`,
      ttlDays: 400,
      notice: {
        title: `Economic nexus reached in ${r.stateName}`,
        body: `Sales into ${r.stateName} are ${r.salesTotal.toFixed(2)} (${r.percentOfThreshold}% of the threshold)${
          r.exceededOn ? `; the threshold was reached on ${r.exceededOn}` : ''
        }${r.collectFrom ? `. Collect sales tax from ${r.collectFrom}${r.collectFromVerified ? '' : ' (check with the state)'}` : ''}. Register to stay compliant.`,
        severity: 'error' as const,
        actionUrl: `${TAX_CENTER_PATH}/nexus`,
        entityType: 'nexus',
        entityId: r.stateCode,
        data: { kind: 'nexus_exceeded', stateCode: r.stateCode },
      },
    }));
}

/** The members who get tax reminders: workspace owners and admins. */
export async function reminderRecipients(db: Database): Promise<string[]> {
  const rows = await db
    .select({ userId: schema.workspaceMembers.userId })
    .from(schema.workspaceMembers)
    .where(
      and(
        inArray(schema.workspaceMembers.role, ['OWNER', 'ADMIN']),
        eq(schema.workspaceMembers.status, 'ACTIVE'),
        isNull(schema.workspaceMembers.deletedAt),
      ),
    );
  return [...new Set(rows.map((r) => r.userId))];
}

export interface TaxReminderResult {
  entities: number;
  /** Notices that went out (each to every recipient). */
  sent: number;
  skipped: number;
  failed: number;
}

export interface TaxReminderOptions {
  notifier: ReminderNotifier;
  markers: ReminderMarkers;
  now?: Date;
  /** Overrides the owners and admins (tests). */
  recipients?: string[];
  /** Run the nexus check regardless of the weekday. */
  forceNexus?: boolean;
}

/** Sends the day's reminders of every US entity in the tenant. */
export async function runTaxReminders(db: Database, options: TaxReminderOptions): Promise<TaxReminderResult> {
  const now = options.now ?? new Date();
  const result: TaxReminderResult = { entities: 0, sent: 0, skipped: 0, failed: 0 };
  const entities = await db
    .select()
    .from(schema.entities)
    .where(and(eq(schema.entities.jurisdictionCode, 'US'), isNull(schema.entities.deletedAt)));
  const active = entities.filter((e) => e.isActive !== false);
  if (active.length === 0) return result;

  const recipients = options.recipients ?? (await reminderRecipients(db));
  if (recipients.length === 0) return result;

  for (const entity of active) {
    result.entities += 1;
    const today = todayIn(entity.timezone, now);
    const candidates: Candidate[] = [];
    const attempt = async (label: string, run: () => Promise<Candidate[]>) => {
      try {
        candidates.push(...(await run()));
      } catch (err) {
        result.failed += 1;
        console.error(`[tax-reminders] ${label} failed for ${entity.id}:`, err instanceof Error ? err.message : err);
      }
    };
    await attempt('sales tax', () => salesTaxCandidates(db, entity, today));
    await attempt('calendar', () => calendarCandidates(db, entity, today, now));
    await attempt('certificates', () => certificateCandidates(db, entity, now));
    if (options.forceNexus || now.getUTCDay() === 1) await attempt('nexus', () => nexusCandidates(db, entity, now));

    // Candidates whose reminder has not been sent yet.
    const fresh: Candidate[] = [];
    for (const candidate of candidates) {
      if (await options.markers.has(candidate.marker)) result.skipped += 1;
      else fresh.push(candidate);
    }

    const notices: Array<{ notice: ReminderNotice; candidates: Candidate[] }> = [];
    const certificates = fresh.filter((c) => c.group === 'certificates');
    for (const candidate of fresh.filter((c) => c.group !== 'certificates')) notices.push({ notice: candidate.notice, candidates: [candidate] });
    if (certificates.length === 1) notices.push({ notice: certificates[0]!.notice, candidates: certificates });
    else if (certificates.length > 1) {
      notices.push({
        candidates: certificates,
        notice: {
          title: `${certificates.length} exemption certificates expire within 30 days`,
          body: certificates
            .slice(0, 5)
            .map((c) => c.notice.body)
            .join(' ') + (certificates.length > 5 ? ` And ${certificates.length - 5} more.` : ''),
          severity: 'warning',
          actionUrl: `${TAX_CENTER_PATH}/certificates`,
          entityType: 'exemption_certificate',
          entityId: entity.id,
          data: { kind: 'certificate_expiring', count: String(certificates.length) },
        },
      });
    }

    for (const { notice, candidates: covered } of notices) {
      let delivered = 0;
      for (const userId of recipients) {
        try {
          await options.notifier.send(userId, notice);
          delivered += 1;
        } catch (err) {
          result.failed += 1;
          console.error(`[tax-reminders] could not notify ${userId}:`, err instanceof Error ? err.message : err);
        }
      }
      // Marked once at least one member was told; a total failure is retried tomorrow.
      if (delivered > 0) {
        result.sent += 1;
        for (const c of covered) await options.markers.set(c.marker, c.ttlDays * DAY_SECONDS);
      }
    }
  }
  return result;
}
