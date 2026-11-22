/**
 * My HR → Performance panels: an evaluation (scores per criterion and the
 * summary), a coaching session (notes and action items), a KPI (latest result
 * and its history) and a milestone. Evaluations and coaching sessions are
 * acknowledged from the panel's menu.
 */

import { useState } from 'react';
import {
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  CheckCheck,
  CircleDot,
  Gauge,
  History,
  LayoutGrid,
  MessageSquareText,
  Shapes,
  Square,
  SquareCheck,
  Building2,
  Tag,
  Target,
  User,
} from 'lucide-react';
import { Badge } from '@weldsuite/ui/components/badge';
import { Progress } from '@weldsuite/ui/components/progress';
import { useTranslations } from '@weldsuite/i18n/client';
import { EntityDetailView } from '@weldsuite/ui/components/entity-detail-view';
import { ObjectPanelTabs, useObjectPanelShell, type ObjectPanelComponentProps } from '@/components/object-panel';
import { PanelRow, PanelSection } from '@/components/objects/_shared/record-panel-parts';
import { tabBodyClassName } from '@/components/objects/_shared/tab-empty-state';
import { TabListRow, TabListScope } from '@/components/objects/_shared/tab-list-row';
import { useMyHrCoaching, useMyHrEvaluations, useMyHrPerformance } from '@/hooks/queries/use-weldhr-queries';
import { MY_HR_PATHS } from '@/app/weldhr/access';
import { ScoreBadge, StatusBadge, formatDate, formatKpiValue, formatMonth } from '@/app/weldhr/components/shared';
import { AcknowledgeDialog, type AcknowledgeTarget } from '@/app/weldhr/me/components/acknowledge-dialog';
import { KpiResultBadge } from '@/app/weldhr/me/components/goals-tab';
import {
  AcknowledgeMenuItem,
  coachingToAcknowledge,
  evaluationPeriod,
  evaluationToAcknowledge,
} from '@/app/weldhr/me/components/reviews-tab';
import { MY_HR_PANEL_WIDTH, MyHrPanelMenu, MyHrPanelMissing, MyHrPanelTitle, useDetailsTab } from './parts';
import { MY_COACHING_PANEL_TYPE, MY_EVALUATION_PANEL_TYPE, MY_KPI_PANEL_TYPE, MY_MILESTONE_PANEL_TYPE } from './types';

/** The acknowledgement rows: when, and the comment you left. */
function AcknowledgementRows({ acknowledgedAt, comment }: Readonly<{ acknowledgedAt: string | null; comment: string | null }>) {
  const t = useTranslations();
  return (
    <>
      <PanelRow
        icon={CheckCheck}
        label={t('weldhr.me.reviews.panel.acknowledgedOn')}
        value={acknowledgedAt ? formatDate(acknowledgedAt) : null}
        tabular
      />
      {comment && <PanelRow icon={MessageSquareText} label={t('weldhr.me.reviews.panel.yourComment')} value={comment} />}
    </>
  );
}

export function MyEvaluationPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const { data, isLoading, error, refetch } = useMyHrEvaluations();
  const evaluation = data?.find((e) => e.id === props.id);
  const [acknowledging, setAcknowledging] = useState<AcknowledgeTarget | null>(null);
  const detailsTab = useDetailsTab();
  const shell = useObjectPanelShell({ ...props, width: MY_HR_PANEL_WIDTH, loading: isLoading && !data });

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(shell.mode)}
      title={<MyHrPanelTitle label={evaluation ? (evaluation.formName ?? t('weldhr.me.reviews.evaluations.untitled')) : undefined} />}
      actions={
        evaluation ? (
          <MyHrPanelMenu listPath={MY_HR_PATHS.reviews} type={MY_EVALUATION_PANEL_TYPE} id={evaluation.id}>
            {evaluationToAcknowledge(evaluation) ? (
              <AcknowledgeMenuItem onSelect={() => setAcknowledging({ kind: 'evaluation', id: evaluation.id })} />
            ) : null}
          </MyHrPanelMenu>
        ) : null
      }
      tabs={<ObjectPanelTabs tabs={[detailsTab]} activeTab={detailsTab.id} onChange={() => {}} />}
    >
      {!evaluation && <MyHrPanelMissing loaded={!!data} error={error} onRetry={() => void refetch()} />}

      {evaluation && (
        <div className="space-y-5 p-4">
          <div className="space-y-1">
            <PanelRow icon={User} label={t('weldhr.me.reviews.evaluations.table.evaluator')} value={evaluation.evaluatorName} />
            <PanelRow icon={CalendarRange} label={t('weldhr.me.reviews.evaluations.table.period')} value={evaluationPeriod(evaluation)} tabular />
            <PanelRow
              icon={Gauge}
              label={t('weldhr.me.reviews.evaluations.table.score')}
              value={evaluation.overallScore === null ? null : String(evaluation.overallScore)}
              renderValue={() => <ScoreBadge score={evaluation.overallScore} />}
            />
            <PanelRow
              icon={CircleDot}
              label={t('weldhr.me.reviews.evaluations.table.status')}
              value={evaluation.status}
              renderValue={() => <StatusBadge group="evaluation" status={evaluation.status} />}
            />
            <PanelRow
              icon={CalendarDays}
              label={t('weldhr.me.reviews.panel.sharedOn')}
              value={evaluation.submittedAt ? formatDate(evaluation.submittedAt) : null}
              tabular
            />
            <AcknowledgementRows acknowledgedAt={evaluation.acknowledgedAt} comment={evaluation.employeeComment} />
          </div>

          {evaluation.criteria.length > 0 && (
            <PanelSection title={t('weldhr.me.reviews.evaluations.criteria')}>
              <div className="space-y-3">
                {evaluation.criteria.map((criterion) => {
                  const scored = evaluation.scores.find((score) => score.criterionId === criterion.id);
                  const percent = scored && criterion.maxScore > 0 ? Math.min(100, (scored.score / criterion.maxScore) * 100) : 0;
                  return (
                    <div key={criterion.id} className="space-y-1">
                      <div className="flex items-center justify-between gap-2 text-sm">
                        <span className="min-w-0 truncate">{criterion.label}</span>
                        <span className="shrink-0 tabular-nums text-muted-foreground">
                          {scored ? scored.score : '—'} / {criterion.maxScore}
                        </span>
                      </div>
                      <Progress value={percent} className="h-1.5" />
                      {scored?.comment && <p className="text-xs text-muted-foreground">{scored.comment}</p>}
                    </div>
                  );
                })}
              </div>
            </PanelSection>
          )}

          {evaluation.summary && (
            <PanelSection title={t('weldhr.me.reviews.evaluations.summary')}>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{evaluation.summary}</p>
            </PanelSection>
          )}
        </div>
      )}

      {acknowledging && <AcknowledgeDialog target={acknowledging} onClose={() => setAcknowledging(null)} />}
    </EntityDetailView>
  );
}

export function MyCoachingPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const { data, isLoading, error, refetch } = useMyHrCoaching();
  const log = data?.find((l) => l.id === props.id);
  const [acknowledging, setAcknowledging] = useState<AcknowledgeTarget | null>(null);
  const detailsTab = useDetailsTab();
  const shell = useObjectPanelShell({ ...props, width: MY_HR_PANEL_WIDTH, loading: isLoading && !data });

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(shell.mode)}
      title={<MyHrPanelTitle label={log ? log.topic || t(`weldhr.status.coachingCategory.${log.category}`) : undefined} />}
      actions={
        log ? (
          <MyHrPanelMenu listPath={MY_HR_PATHS.reviews} type={MY_COACHING_PANEL_TYPE} id={log.id}>
            {coachingToAcknowledge(log) ? (
              <AcknowledgeMenuItem onSelect={() => setAcknowledging({ kind: 'coaching', id: log.id })} />
            ) : null}
          </MyHrPanelMenu>
        ) : null
      }
      tabs={<ObjectPanelTabs tabs={[detailsTab]} activeTab={detailsTab.id} onChange={() => {}} />}
    >
      {!log && <MyHrPanelMissing loaded={!!data} error={error} onRetry={() => void refetch()} />}

      {log && (
        <div className="space-y-5 p-4">
          <div className="space-y-1">
            <PanelRow icon={CalendarDays} label={t('weldhr.me.reviews.coaching.table.date')} value={formatDate(log.sessionDate)} tabular />
            <PanelRow
              icon={Tag}
              label={t('weldhr.me.reviews.coaching.table.category')}
              value={log.category}
              renderValue={() => <Badge variant="secondary">{t(`weldhr.status.coachingCategory.${log.category}`)}</Badge>}
            />
            <PanelRow icon={User} label={t('weldhr.me.reviews.coaching.table.coach')} value={log.coachName} />
            <PanelRow
              icon={CalendarClock}
              label={t('weldhr.me.reviews.coaching.table.followUp')}
              value={log.followUpDate ? formatDate(log.followUpDate) : null}
              tabular
            />
            <PanelRow
              icon={CircleDot}
              label={t('weldhr.me.reviews.coaching.table.status')}
              value={log.status}
              renderValue={() => <StatusBadge group="coaching" status={log.status} />}
            />
            <AcknowledgementRows acknowledgedAt={log.acknowledgedAt} comment={log.employeeComment} />
          </div>

          {log.notes && (
            <PanelSection title={t('weldhr.me.reviews.panel.notes')}>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{log.notes}</p>
            </PanelSection>
          )}

          {log.actionItems.length > 0 && (
            <PanelSection title={t('weldhr.me.reviews.coaching.actionItems')}>
              <ul className="space-y-1.5 text-sm">
                {log.actionItems.map((item) => (
                  <li key={item.id} className="flex items-start gap-2">
                    {item.done ? (
                      <SquareCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                    ) : (
                      <Square className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <span className={item.done ? 'text-muted-foreground line-through' : undefined}>{item.text}</span>
                  </li>
                ))}
              </ul>
            </PanelSection>
          )}
        </div>
      )}

      {acknowledging && <AcknowledgeDialog target={acknowledging} onClose={() => setAcknowledging(null)} />}
    </EntityDetailView>
  );
}

type KpiTab = 'overview' | 'history';

/** "September 2026" for a period that is one whole month, otherwise the dates. */
function kpiPeriod(start: string, end: string): string {
  const [y, m] = start.split('-').map(Number);
  const lastDay = new Date(y!, m!, 0).getDate();
  const wholeMonth = start.endsWith('-01') && end.slice(0, 7) === start.slice(0, 7) && Number(end.slice(8, 10)) === lastDay;
  return wholeMonth ? formatMonth(start) : `${formatDate(start)} – ${formatDate(end)}`;
}

export function MyKpiPanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const { data, isLoading, error, refetch } = useMyHrPerformance();
  // The panel is keyed by the KPI: its results, newest first.
  const results = (data?.kpis ?? []).filter((k) => k.kpiId === props.id).sort((a, b) => b.periodEnd.localeCompare(a.periodEnd));
  const latest = results[0];
  const [tab, setTab] = useState<KpiTab>(props.initialTab === 'history' ? 'history' : 'overview');
  const shell = useObjectPanelShell({ ...props, width: MY_HR_PANEL_WIDTH, loading: isLoading && !data });
  const tabs = [
    { id: 'overview', label: t('sweep.entities.detailsTab'), icon: LayoutGrid },
    { id: 'history', label: t('weldhr.me.goals.kpis.history'), icon: History, count: results.length || undefined },
  ];

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(shell.mode)}
      title={<MyHrPanelTitle label={latest?.kpiName} />}
      actions={latest ? <MyHrPanelMenu listPath={MY_HR_PATHS.reviews} type={MY_KPI_PANEL_TYPE} id={latest.kpiId} /> : null}
      tabs={<ObjectPanelTabs tabs={tabs} activeTab={tab} onChange={(next) => setTab(next as KpiTab)} />}
    >
      {!latest && <MyHrPanelMissing loaded={!!data} error={error} onRetry={() => void refetch()} />}

      {latest && tab === 'overview' && (
        <div className="space-y-1 p-4">
          <PanelRow icon={Gauge} label={t('weldhr.me.goals.kpis.table.value')} value={formatKpiValue(latest.value, latest.unit)} tabular />
          <PanelRow
            icon={Target}
            label={t('weldhr.me.goals.kpis.table.target')}
            value={latest.target === null ? null : formatKpiValue(latest.target, latest.unit)}
            tabular
          />
          <PanelRow
            icon={CircleDot}
            label={t('weldhr.me.goals.kpis.table.result')}
            value={String(latest.onTarget)}
            renderValue={() => <KpiResultBadge kpi={latest} />}
          />
          <PanelRow
            icon={CalendarRange}
            label={t('weldhr.me.goals.kpis.table.period')}
            value={`${formatDate(latest.periodStart)} – ${formatDate(latest.periodEnd)}`}
            tabular
          />
        </div>
      )}

      {latest && tab === 'history' && (
        <TabListScope>
          {results.map((result) => (
            <TabListRow key={result.id} label={kpiPeriod(result.periodStart, result.periodEnd)} className="gap-3">
              <span className="min-w-0 flex-1 truncate text-sm tabular-nums">{kpiPeriod(result.periodStart, result.periodEnd)}</span>
              <span className="w-[72px] shrink-0 text-right text-sm font-medium tabular-nums">{formatKpiValue(result.value, result.unit)}</span>
              <span className="flex w-[96px] shrink-0 justify-end">
                <KpiResultBadge kpi={result} />
              </span>
            </TabListRow>
          ))}
        </TabListScope>
      )}
    </EntityDetailView>
  );
}

export function MyMilestonePanel(props: Readonly<ObjectPanelComponentProps>) {
  const t = useTranslations();
  const { data, isLoading, error, refetch } = useMyHrPerformance();
  const milestone = data?.milestones.find((m) => m.id === props.id);
  const detailsTab = useDetailsTab();
  const shell = useObjectPanelShell({ ...props, width: MY_HR_PANEL_WIDTH, loading: isLoading && !data });

  return (
    <EntityDetailView
      {...shell.entityDetailViewProps}
      contentClassName={tabBodyClassName(shell.mode)}
      title={<MyHrPanelTitle label={milestone?.title} />}
      actions={milestone ? <MyHrPanelMenu listPath={MY_HR_PATHS.reviews} type={MY_MILESTONE_PANEL_TYPE} id={milestone.id} /> : null}
      tabs={<ObjectPanelTabs tabs={[detailsTab]} activeTab={detailsTab.id} onChange={() => {}} />}
    >
      {!milestone && <MyHrPanelMissing loaded={!!data} error={error} onRetry={() => void refetch()} />}

      {milestone && (
        <div className="space-y-5 p-4">
          <div className="space-y-1">
            <PanelRow icon={Shapes} label={t('weldhr.me.goals.milestones.table.type')} value={t(`weldhr.status.milestoneType.${milestone.type}`)} />
            <PanelRow
              icon={CircleDot}
              label={t('weldhr.me.goals.milestones.table.status')}
              value={milestone.status}
              renderValue={() => <StatusBadge group="milestone" status={milestone.status} />}
            />
            <PanelRow
              icon={CalendarClock}
              label={t('weldhr.me.goals.milestones.table.due')}
              value={milestone.dueDate ? formatDate(milestone.dueDate) : null}
              tabular
            />
            <PanelRow
              icon={CalendarCheck}
              label={t('weldhr.me.goals.milestones.table.achieved')}
              value={milestone.achievedAt ? formatDate(milestone.achievedAt) : null}
              tabular
            />
            <PanelRow icon={Building2} label={t('weldhr.me.goals.milestones.table.client')} value={milestone.companyName} />
          </div>
          {milestone.description && (
            <PanelSection title={t('weldhr.me.goals.milestones.table.description')}>
              <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{milestone.description}</p>
            </PanelSection>
          )}
        </div>
      )}
    </EntityDetailView>
  );
}
