import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@weldsuite/ui/components/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@weldsuite/ui/components/form'
import { Textarea } from '@weldsuite/ui/components/textarea'
import { cn } from '@weldsuite/ui/lib/utils'
import type { PortalMessage } from '@weldsuite/app-api-client/schemas/project-portal'
import { loadMessages, sendMessage, type FailureCode, type Page } from '@/lib/portal'
import type { PortalStrings } from '@/lib/i18n'
import { initials } from '@/lib/format'
import { usePortal } from '@/components/portal-context'
import { EmptyText, Section } from '@/components/ui-bits'

const MESSAGE_MAX = 4000

/** Oldest first. A message is known by its id, so merging a page twice adds nothing. */
function chronological(messages: Iterable<PortalMessage>): PortalMessage[] {
  const byId = new Map<string, PortalMessage>()
  for (const message of messages) byId.set(message.id, message)
  return [...byId.values()].sort(compareMessages)
}

function compareMessages(a: PortalMessage, b: PortalMessage): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return 0
}

function sendFailureText(t: PortalStrings, code: FailureCode): string {
  switch (code) {
    case 'signed_out':
      return t.errors.signedOut
    case 'unavailable':
      return t.errors.unavailable
    default:
      return t.project.messages.sendFailed
  }
}

function MessageItem({ message }: Readonly<{ message: PortalMessage }>) {
  const { t, format } = usePortal()
  const m = t.project.messages
  const name = message.mine ? m.you : message.senderName
  return (
    <li className="flex gap-2.5">
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
          message.fromClient
            ? 'bg-amber-200 text-neutral-900 dark:bg-amber-400/25 dark:text-amber-100'
            : 'bg-blue-100 text-neutral-900 dark:bg-blue-400/25 dark:text-blue-100',
        )}
      >
        {initials(message.senderName)}
      </span>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">
          <strong className="font-semibold text-foreground">{name}</strong> · {format.dateTime(message.createdAt)}
          {message.editedAt && ` · ${m.edited}`}
        </p>
        <p className="mt-0.5 text-[13px] leading-relaxed break-words whitespace-pre-wrap">{message.message}</p>
      </div>
    </li>
  )
}

/**
 * The thread with the project team. The API lists newest first with a cursor;
 * it is shown oldest first, with "Load earlier messages" on top. What the
 * contact writes is added to the thread as the API returns it.
 */
export function Messages({
  workspace,
  projectId,
  first,
  className,
}: Readonly<{ workspace: string; projectId: string; first: Page<PortalMessage>; className?: string }>) {
  const { t } = usePortal()
  const m = t.project.messages
  const [items, setItems] = useState<PortalMessage[]>(() => chronological(first.items))
  const [paging, setPaging] = useState({ cursor: first.cursor, hasMore: first.hasMore })
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [loadProblem, setLoadProblem] = useState(false)
  const [sendProblem, setSendProblem] = useState<string | null>(null)

  const schema = z.object({
    message: z.string().trim().min(1, m.required).max(MESSAGE_MAX, m.tooLong),
  })
  const form = useForm<{ message: string }>({ resolver: zodResolver(schema), defaultValues: { message: '' } })

  async function loadEarlier() {
    if (!paging.cursor || loadingEarlier) return
    setLoadingEarlier(true)
    setLoadProblem(false)
    try {
      const result = await loadMessages({ data: { workspace, projectId, cursor: paging.cursor } })
      if (!result.ok) {
        setLoadProblem(true)
        return
      }
      setItems((current) => chronological([...current, ...result.data.items]))
      setPaging({ cursor: result.data.cursor, hasMore: result.data.hasMore })
    } finally {
      setLoadingEarlier(false)
    }
  }

  /** The newest page again: what the team wrote since this page was loaded. */
  async function refresh() {
    if (refreshing) return
    setRefreshing(true)
    setLoadProblem(false)
    try {
      const result = await loadMessages({ data: { workspace, projectId } })
      if (!result.ok) {
        setLoadProblem(true)
        return
      }
      const fresh = result.data.items
      // A page that does not reach back to what is shown leaves a gap: start over from it.
      const known = new Set(items.map((item) => item.id))
      if (items.length > 0 && !fresh.some((item) => known.has(item.id)) && result.data.hasMore) {
        setItems(chronological(fresh))
        setPaging({ cursor: result.data.cursor, hasMore: result.data.hasMore })
      } else {
        setItems((current) => chronological([...current, ...fresh]))
      }
    } finally {
      setRefreshing(false)
    }
  }

  async function submit(values: { message: string }) {
    setSendProblem(null)
    const result = await sendMessage({ data: { workspace, projectId, message: values.message.trim() } })
    if (result.ok) {
      setItems((current) => chronological([...current, result.data]))
      form.reset({ message: '' })
      return
    }
    setSendProblem(sendFailureText(t, result.code))
  }

  const sending = form.formState.isSubmitting
  return (
    <Section
      title={m.title}
      className={className}
      action={
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={m.refresh}
          title={m.refresh}
          disabled={refreshing}
          onClick={() => void refresh()}
        >
          <RefreshCw className={refreshing ? 'animate-spin' : undefined} aria-hidden="true" />
        </Button>
      }
    >
      {paging.hasMore && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mb-3"
          disabled={loadingEarlier}
          onClick={() => void loadEarlier()}
        >
          {loadingEarlier && <Loader2 className="animate-spin" aria-hidden="true" />}
          {m.loadEarlier}
        </Button>
      )}
      {loadProblem && (
        <p role="alert" className="mb-3 text-sm text-destructive">
          {m.loadFailed}
        </p>
      )}

      {items.length === 0 ? (
        <EmptyText>{m.empty}</EmptyText>
      ) : (
        <ol className="flex flex-col gap-3.5">
          {items.map((message) => (
            <MessageItem key={message.id} message={message} />
          ))}
        </ol>
      )}

      <Form {...form}>
        <form onSubmit={form.handleSubmit(submit)} noValidate className="mt-4 flex flex-col gap-2">
          <FormField
            control={form.control}
            name="message"
            render={({ field }) => (
              <FormItem>
                <FormLabel className="text-xs font-normal text-muted-foreground">{m.replyLabel}</FormLabel>
                <FormControl>
                  <Textarea {...field} rows={2} placeholder={m.placeholder} />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          {sendProblem && (
            <p role="alert" className="text-sm text-destructive">
              {sendProblem}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={sending}>
              {sending && <Loader2 className="animate-spin" aria-hidden="true" />}
              {sending ? m.sending : m.send}
            </Button>
          </div>
        </form>
      </Form>
    </Section>
  )
}
