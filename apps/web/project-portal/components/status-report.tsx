import { useId, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@weldsuite/ui/components/button'
import type { PortalReport } from '@weldsuite/app-api-client/schemas/project-portal'
import { loadReports } from '@/lib/portal'
import { reportArea, reportColour } from '@/lib/labels'
import { usePortal } from '@/components/portal-context'
import { Chip, EmptyText, Section, colourTone } from '@/components/ui-bits'

/** One published report as the team froze it: colours per area, the summary, what is done and what comes next. */
function ReportView({ report, latest }: Readonly<{ report: PortalReport; latest: boolean }>) {
  const { t, fill, format } = usePortal()
  const u = t.project.update
  const period = format.period(report.period, (week) => fill(u.week, { week }))
  const meta = [
    fill(u.meta, { period, date: format.date(report.publishedAt) }),
    ...(report.publishedByName ? [fill(u.from, { name: report.publishedByName })] : []),
  ].join(' · ')

  const Heading = latest ? 'span' : 'h3'
  return (
    <div>
      <Heading className="text-xs text-muted-foreground">{meta}</Heading>
      {(report.overall || report.areas.length > 0) && (
        <ul className="mt-2.5 flex flex-wrap gap-1.5">
          {report.overall && (
            <li>
              <Chip tone={colourTone(report.overall)} dot>
                {t.rag.overall}: {reportColour(t, report.overall)}
              </Chip>
            </li>
          )}
          {report.areas.map((area) => (
            <li key={area.key}>
              <Chip tone={colourTone(area.colour)} dot>
                {reportArea(t, area.key)}: {reportColour(t, area.colour)}
              </Chip>
            </li>
          ))}
        </ul>
      )}
      {report.summary && <p className="mt-3 text-[13px] leading-relaxed whitespace-pre-line">{report.summary}</p>}
      {report.done.length > 0 && (
        <>
          <h4 className="mt-3.5 mb-1.5 text-[13px] font-semibold">{u.done}</h4>
          <ul className="list-disc space-y-1 pl-[18px] text-[13px] leading-relaxed">
            {report.done.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {report.next.length > 0 && (
        <>
          <h4 className="mt-3.5 mb-1.5 text-[13px] font-semibold">{u.next}</h4>
          <ul className="list-disc space-y-1 pl-[18px] text-[13px] leading-relaxed">
            {report.next.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

/**
 * The newest report the team shared, and "Earlier updates" that unfolds the
 * older ones from the paged reports list (the first time it is opened).
 */
export function LatestUpdate({
  workspace,
  projectId,
  report,
  className,
}: Readonly<{ workspace: string; projectId: string; report: PortalReport | null; className?: string }>) {
  const { t } = usePortal()
  const u = t.project.update
  const panelId = useId()
  const [open, setOpen] = useState(false)
  const [earlier, setEarlier] = useState<PortalReport[]>([])
  const [paging, setPaging] = useState<{ cursor: string | null; hasMore: boolean } | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  async function fetchPage(cursor: string | null) {
    setLoading(true)
    setFailed(false)
    try {
      const result = await loadReports({ data: { workspace, projectId, cursor } })
      if (!result.ok) {
        setFailed(true)
        return
      }
      const page = result.data
      // The newest report is the one above, not an earlier one.
      setEarlier((current) => [...current, ...page.items.filter((item) => item.id !== report?.id)])
      setPaging({ cursor: page.cursor, hasMore: page.hasMore })
    } finally {
      setLoading(false)
    }
  }

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && paging === null && !loading) void fetchPage(null)
  }

  return (
    <Section title={u.title} className={className}>
      {report ? <ReportView report={report} latest /> : <EmptyText>{u.empty}</EmptyText>}

      {report && (
        <div className="mt-3">
          <Button
            type="button"
            variant="link"
            className="h-auto p-0 text-[13px]"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={toggle}
          >
            {open ? u.hideEarlier : u.earlier}
          </Button>
          <div id={panelId} hidden={!open}>
            {open && (
              <div className="mt-2 flex flex-col gap-4">
                {earlier.map((item) => (
                  <div key={item.id} className="border-t pt-4">
                    <ReportView report={item} latest={false} />
                  </div>
                ))}
                {paging !== null && earlier.length === 0 && !loading && !failed && (
                  <p className="border-t pt-4 text-[13px] text-muted-foreground">{u.noEarlier}</p>
                )}
                {failed && (
                  <p role="alert" className="text-sm text-destructive">
                    {u.failed}
                  </p>
                )}
                {loading && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={t.common.loading} />}
                {paging?.hasMore && !loading && (
                  <div>
                    <Button type="button" variant="outline" size="sm" onClick={() => void fetchPage(paging.cursor)}>
                      {u.loadMore}
                    </Button>
                  </div>
                )}
                {failed && paging === null && !loading && (
                  <div>
                    <Button type="button" variant="outline" size="sm" onClick={() => void fetchPage(null)}>
                      {t.common.tryAgain}
                    </Button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Section>
  )
}
