import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Check, CircleCheck, Circle, Loader2 } from 'lucide-react'
import { Button } from '@weldsuite/ui/components/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@weldsuite/ui/components/dialog'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form'
import { Textarea } from '@weldsuite/ui/components/textarea'
import type { PortalApproval, PortalDecision } from '@weldsuite/app-api-client/schemas/project-portal'
import { decideApproval, type FailureCode } from '@/lib/portal'
import type { PortalStrings } from '@/lib/i18n'
import { usePortal } from '@/components/portal-context'
import { Chip, EmptyText, Section } from '@/components/ui-bits'

/** The five things a contact can do; each one is one of the three decisions the API takes. */
type ActionKind = 'accept' | 'approve' | 'changes' | 'decline' | 'ask'

interface ActionDef {
  decision: PortalDecision
  /** Declining, asking for changes and asking a question need a note; accepting does not. */
  noteRequired: boolean
}

const ACTIONS: Record<ActionKind, ActionDef> = {
  accept: { decision: 'approved', noteRequired: false },
  approve: { decision: 'approved', noteRequired: false },
  changes: { decision: 'rejected', noteRequired: true },
  decline: { decision: 'rejected', noteRequired: true },
  ask: { decision: 'info_requested', noteRequired: true },
}

const NOTE_MAX = 2000

/** A line of the section: a review still waiting, or one answered during this visit. */
type Row =
  | { id: string; done: Answered; approval: null }
  | { id: string; done: null; approval: PortalApproval }

interface Answered {
  approval: PortalApproval
  action: ActionKind
  note: string | null
}

function failureText(t: PortalStrings, code: FailureCode): string {
  switch (code) {
    case 'conflict':
      return t.project.waiting.errors.conflict
    case 'not_found':
      return t.project.waiting.errors.notFound
    case 'forbidden':
      return t.project.waiting.errors.forbidden
    case 'invalid':
      return t.project.waiting.errors.invalid
    case 'signed_out':
      return t.errors.signedOut
    case 'unavailable':
      return t.errors.unavailable
    default:
      return t.errors.generic
  }
}

// ============================================================================
// The answer dialog
// ============================================================================

function DecisionDialog({
  workspace,
  approval,
  action,
  onClose,
  onAnswered,
}: Readonly<{
  workspace: string
  approval: PortalApproval
  action: ActionKind
  onClose: () => void
  onAnswered: (note: string | null) => void
}>) {
  const { t, fill } = usePortal()
  const def = ACTIONS[action]
  const d = t.project.waiting.dialog
  const [problem, setProblem] = useState<string | null>(null)

  const schema = z.object({
    note: def.noteRequired
      ? z.string().trim().min(1, d.noteRequired).max(NOTE_MAX, d.noteTooLong)
      : z.string().trim().max(NOTE_MAX, d.noteTooLong),
  })
  const form = useForm<{ note: string }>({ resolver: zodResolver(schema), defaultValues: { note: '' } })

  const copy = {
    accept: { title: d.acceptTitle, body: d.acceptBody, label: d.noteOptional, confirm: d.confirmAccept },
    approve: { title: d.approveTitle, body: d.approveBody, label: d.noteOptional, confirm: d.confirmApprove },
    changes: { title: d.changesTitle, body: d.changesBody, label: d.changesLabel, confirm: d.confirmChanges },
    decline: { title: d.declineTitle, body: d.declineBody, label: d.declineLabel, confirm: d.confirmDecline },
    ask: { title: d.askTitle, body: d.askBody, label: d.askLabel, confirm: d.confirmAsk },
  }[action]

  async function submit(values: { note: string }) {
    setProblem(null)
    const note = values.note.trim()
    const result = await decideApproval({
      data: { workspace, approvalId: approval.id, decision: def.decision, note: note || null },
    })
    if (result.ok) {
      onAnswered(note || null)
      return
    }
    setProblem(failureText(t, result.code))
  }

  const sending = form.formState.isSubmitting
  return (
    <Dialog open onOpenChange={(open) => !open && !sending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{fill(copy.title, { code: approval.code })}</DialogTitle>
          <DialogDescription>{fill(copy.body, { code: approval.code })}</DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(submit)} noValidate className="flex flex-col gap-4">
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>{copy.label}</FormLabel>
                  <FormControl>
                    <Textarea {...field} rows={4} autoFocus={def.noteRequired} placeholder={d.notePlaceholder} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {problem && (
              <p role="alert" className="text-sm text-destructive">
                {problem}
              </p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={sending} onClick={onClose}>
                {t.common.cancel}
              </Button>
              <Button type="submit" disabled={sending}>
                {sending && <Loader2 className="animate-spin" aria-hidden="true" />}
                {sending ? d.sending : copy.confirm}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}

// ============================================================================
// One review
// ============================================================================

function Criteria({ approval }: Readonly<{ approval: PortalApproval }>) {
  const { t } = usePortal()
  const w = t.project.waiting
  return (
    <div className="mt-3">
      <h4 className="text-xs text-muted-foreground">{w.criteria}</h4>
      {approval.acceptanceCriteria.length === 0 ? (
        <p className="mt-1.5 text-[13px] text-muted-foreground">{w.noCriteria}</p>
      ) : (
        <ul className="mt-1.5 flex flex-col gap-2">
          {approval.acceptanceCriteria.map((criterion, index) => (
            <li key={`${index}-${criterion.text}`} className="flex items-start gap-2 text-[13px]">
              {criterion.met ? (
                <CircleCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <Circle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              )}
              <span>
                {criterion.text}
                <span className="sr-only"> ({criterion.met ? w.criterionMet : w.criterionOpen})</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Impact({ approval }: Readonly<{ approval: PortalApproval }>) {
  const { t, format, plural } = usePortal()
  const { impact } = approval
  if (!impact) return null
  const w = t.project.waiting.impact
  const cost = impact.costDelta !== null ? format.money(impact.costDelta, impact.currency) : ''
  const time =
    impact.scheduleDeltaDays !== null
      ? plural(w.days, impact.scheduleDeltaDays, { count: format.signed(impact.scheduleDeltaDays) })
      : ''
  const goLive = format.date(impact.newGoLive)

  const tiles = [
    { label: w.cost, value: cost || w.noChange, emphasis: false },
    { label: w.time, value: time || w.noChange, emphasis: false },
    { label: w.goLive, value: goLive || w.noChange, emphasis: goLive !== '' },
  ]
  return (
    <dl aria-label={w.title} className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
      {tiles.map((tile) => (
        <div key={tile.label} className="rounded-lg border bg-background p-2.5">
          <dt className="text-xs text-muted-foreground">{tile.label}</dt>
          <dd
            className={
              tile.emphasis
                ? 'mt-0.5 text-base font-semibold text-amber-700 dark:text-amber-400'
                : 'mt-0.5 text-base font-semibold'
            }
          >
            {tile.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function ApprovalCard({
  workspace,
  approval,
  onAnswered,
}: Readonly<{
  workspace: string
  approval: PortalApproval
  onAnswered: (approval: PortalApproval, action: ActionKind, note: string | null) => void
}>) {
  const { t, fill, format } = usePortal()
  const w = t.project.waiting
  const [action, setAction] = useState<ActionKind | null>(null)
  const isChange = approval.subjectType === 'change_request'
  const disabled = !approval.actionable

  const sent = approval.requestedByName
    ? fill(w.sentBy, { date: format.date(approval.requestedAt), name: approval.requestedByName })
    : fill(w.sent, { date: format.date(approval.requestedAt) })
  const due = approval.dueAt ? format.date(approval.dueAt) : ''

  return (
    <article
      className={
        isChange
          ? 'rounded-lg border border-amber-500/30 bg-amber-500/5 p-3.5'
          : 'rounded-lg border p-3.5'
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={isChange ? 'warn' : 'info'}>{isChange ? w.kindChange : w.kindDeliverable}</Chip>
        <span className="text-xs text-muted-foreground">
          {sent}
          {due && ` · ${fill(w.replyBy, { date: due })}`}
        </span>
      </div>
      <h3 className="mt-2 text-sm font-semibold">
        {approval.code} · {approval.title}
      </h3>
      {approval.description && (
        <p className="mt-1 text-[13px] whitespace-pre-line text-muted-foreground">{approval.description}</p>
      )}

      {isChange ? <Impact approval={approval} /> : <Criteria approval={approval} />}

      {disabled && <p className="mt-3 text-xs text-muted-foreground">{w.earlierStep}</p>}
      <div className="mt-3.5 flex flex-wrap gap-2">
        <Button type="button" disabled={disabled} onClick={() => setAction(isChange ? 'approve' : 'accept')}>
          {fill(isChange ? w.approve : w.accept, { code: approval.code })}
        </Button>
        <Button type="button" variant="outline" disabled={disabled} onClick={() => setAction(isChange ? 'decline' : 'changes')}>
          {isChange ? w.decline : w.requestChanges}
        </Button>
        {isChange && (
          <Button type="button" variant="outline" disabled={disabled} onClick={() => setAction('ask')}>
            {w.ask}
          </Button>
        )}
        {!isChange && (
          <Button type="button" variant="ghost" disabled={disabled} onClick={() => setAction('ask')}>
            {w.ask}
          </Button>
        )}
      </div>

      {action && (
        <DecisionDialog
          workspace={workspace}
          approval={approval}
          action={action}
          onClose={() => setAction(null)}
          onAnswered={(note) => {
            setAction(null)
            onAnswered(approval, action, note)
          }}
        />
      )}
    </article>
  )
}

function AnsweredCard({ answered }: Readonly<{ answered: Answered }>) {
  const { t, fill } = usePortal()
  const w = t.project.waiting.answered
  const { approval, action, note } = answered
  const headline = {
    accept: w.accepted,
    approve: w.approved,
    changes: w.changes,
    decline: w.declined,
    ask: w.question,
  }[action]

  return (
    <article className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3.5" role="status">
      <div className="flex items-start gap-2.5">
        <span
          aria-hidden="true"
          className="mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
        >
          <Check className="size-3.5" />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">{fill(headline, { code: approval.code })}</h3>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{approval.title}</p>
          <p className="mt-2 text-[13px]">{action === 'ask' ? w.questionSent : w.told}</p>
          {note && <p className="mt-1 text-[13px] whitespace-pre-line text-muted-foreground">{fill(w.yourNote, { note })}</p>}
        </div>
      </div>
    </article>
  )
}

// ============================================================================
// The section
// ============================================================================

/**
 * What waits for the contact on this project. An answered review stays on the
 * page, in place, as a confirmation, even after the page's data is fetched
 * again and the API no longer lists it.
 */
export function WaitingForYou({
  workspace,
  approvals,
  className,
}: Readonly<{ workspace: string; approvals: PortalApproval[]; className?: string }>) {
  const { t } = usePortal()
  const router = useRouter()
  // Every review this visit has shown, in the order first seen.
  const [known, setKnown] = useState<PortalApproval[]>(approvals)
  const [answered, setAnswered] = useState<ReadonlyMap<string, Answered>>(new Map())

  const unseen = approvals.filter((approval) => !known.some((seen) => seen.id === approval.id))
  if (unseen.length > 0) setKnown([...known, ...unseen])

  function handleAnswered(approval: PortalApproval, action: ActionKind, note: string | null) {
    setAnswered((current) => new Map(current).set(approval.id, { approval, action, note }))
    // The tiles, statuses and counts of the page come from its data: fetch it again.
    void router.invalidate()
  }

  const live = new Map(approvals.map((approval) => [approval.id, approval]))
  const rows = known.flatMap((seen): Row[] => {
    const done = answered.get(seen.id)
    if (done) return [{ id: seen.id, done, approval: null }]
    const current = live.get(seen.id)
    return current ? [{ id: seen.id, done: null, approval: current }] : []
  })

  return (
    <Section title={t.project.waiting.title} className={className}>
      {rows.length === 0 ? (
        <EmptyText>{t.project.waiting.empty}</EmptyText>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((row) =>
            row.done ? (
              <AnsweredCard key={row.id} answered={row.done} />
            ) : (
              <ApprovalCard key={row.id} workspace={workspace} approval={row.approval} onAnswered={handleAnswered} />
            ),
          )}
        </div>
      )}
    </Section>
  )
}
