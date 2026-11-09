import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FormRenderer, themeStyle, type FormRendererProps, type ProgressEvent, type SubmitFieldErrors, type SubmitPayload, type SubmitResult } from '@weldsuite/forms-renderer'
import { postToHost, type EmbedMode } from '@weldsuite/forms-embed/protocol'
import type { AnswerError, Answers, FileAnswerItem, FormDefinition } from '@weldsuite/forms-engine'
import type { PublicForm, StartSessionInput, StartSessionResult } from '@weldsuite/app-api-client/schemas/weldforms'
import { ApiError, formsApi, uploadFile } from '@/lib/client/api'
import { collectMetadata, hiddenFromSearch, isSafeUrl } from '@/lib/client/environment'
import { browserKey, clearStoredSession, loadStoredSession, saveStoredSession, viewKey } from '@/lib/client/storage'
import { Footer } from './footer'
import { MessageScreen } from './message-screen'
import { usePortal } from './portal-context'
import { ReportDialog } from './report-dialog'
import { useBotCheck } from './use-bot-check'
import { VerifyEmail } from './verify-email'

interface FormPageProps {
  form: PublicForm
  /** Stable per page load (made on the server), so randomized choices hydrate the same. */
  seed: string
  invitationToken?: string
  embed: EmbedMode | null
  /** The raw query string of the page (`?a=1&embed=popup`), for hidden fields and UTM tags. */
  search: string
}

interface ActiveSession {
  token: string
  responseId: string
}

/** What the form starts with after a session resumed or a completed response is edited. */
interface StartState {
  answers: Answers
  hidden: Record<string, string>
  lastBlockId: string | null
  editing: boolean
}

type Phase = 'resuming' | 'verify' | 'ready' | 'completed' | 'invitation_revoked' | 'invitation_invalid' | 'error'

const PROGRESS_DEBOUNCE_MS = 1500

function sumTimings(a: Record<string, number> | undefined, b: Record<string, number>): Record<string, number> {
  const out = { ...(a ?? {}) }
  for (const [id, ms] of Object.entries(b)) out[id] = (out[id] ?? 0) + ms
  return out
}

/** forms-api takes whole milliseconds, at most a day per block. */
function cleanTimings(timings: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [id, ms] of Object.entries(timings)) out[id] = Math.min(86_400_000, Math.max(0, Math.round(ms)))
  return out
}

function initialPhase(form: PublicForm, invitationToken: string | undefined): Phase {
  if (invitationToken) return 'resuming'
  return form.respondentMode === 'verified_email' ? 'verify' : 'ready'
}

/** Whether this browser's stored session may be picked up again: only forms that keep, limit or verify responses resume. */
function canResume(form: PublicForm): boolean {
  return form.collectPartial || form.allowEdit || form.onePerRespondent || form.respondentMode === 'verified_email'
}

/** The screen a failed page open ends on. */
function openErrorPhase(err: unknown): Phase {
  if (err instanceof ApiError && err.code === 'INVITATION_REVOKED') return 'invitation_revoked'
  if (err instanceof ApiError && err.status === 404) return 'invitation_invalid'
  return 'error'
}

/** Where the renderer starts after a resumed session or for an edit: the earlier answers, and the block the respondent was on. */
function rendererStart(start: StartState | null): Pick<FormRendererProps, 'initialAnswers' | 'skipWelcome' | 'startAtBlockId'> {
  if (!start) return {}
  return {
    initialAnswers: start.answers,
    ...(start.editing ? { skipWelcome: true } : {}),
    ...(start.lastBlockId && !start.editing ? { startAtBlockId: start.lastBlockId } : {}),
  }
}

/**
 * The respondent's experience of one open form: the renderer, and around it
 * the session (started lazily for anonymous forms, so a visitor who only looks
 * costs nothing), progress saving, uploads, the verified-email steps, the
 * bot check, the embed protocol and the footer.
 */
export function FormPage({ form, seed, invitationToken, embed, search }: Readonly<FormPageProps>) {
  const { t } = usePortal()
  const publicId = form.publicId
  const embedded = embed !== null
  const [definition, setDefinition] = useState<FormDefinition | null>(form.definition)
  const [phase, setPhase] = useState<Phase>(() => initialPhase(form, invitationToken))
  const [start, setStart] = useState<StartState | null>(null)
  const [rendererKey, setRendererKey] = useState(0)
  const [reporting, setReporting] = useState(false)
  const [retry, setRetry] = useState(0)

  const declared = useMemo(() => (definition?.hidden ?? []).map((h) => h.name), [definition])
  const queryHidden = useMemo(() => hiddenFromSearch(search, declared), [search, declared])
  const source = useMemo(() => {
    if (invitationToken) return 'invitation'
    if (embed) return embed
    return new URLSearchParams(search).get('source') === 'qr' ? 'qr' : 'link'
  }, [invitationToken, embed, search])

  const bot = useBotCheck(form.botCheck.provider, form.botCheck.siteKey, !invitationToken)
  const session = useRef<ActiveSession | null>(null)
  const starting = useRef<Promise<ActiveSession> | null>(null)
  const verification = useRef<string | undefined>(undefined)
  const honeypot = useRef<HTMLInputElement>(null)
  const shell = useRef<HTMLDivElement>(null)

  // ----- session -----

  /** Applies what forms-api answered to a session start. */
  const applyStart = useCallback(
    async (result: StartSessionResult, eager: boolean): Promise<void> => {
      session.current = { token: result.session, responseId: result.responseId }
      saveStoredSession(publicId, { session: result.session, responseId: result.responseId, expiresAt: result.expiresAt })
      if (!eager) return
      // A response started on an older version continues on that version.
      if (result.versionId !== form.versionId) {
        const older = await formsApi.form(publicId, result.versionId)
        if (older.definition) setDefinition(older.definition)
      }
      if (result.completed && !result.completed.editable) {
        setPhase('completed')
        return
      }
      setStart({ answers: result.answers as Answers, hidden: result.hidden, lastBlockId: result.lastBlockId, editing: Boolean(result.completed) })
      setRendererKey((k) => k + 1)
      setPhase('ready')
    },
    [form.versionId, publicId],
  )

  const startInput = useCallback(
    (extra: Partial<StartSessionInput>): StartSessionInput => ({
      browserKey: browserKey(publicId),
      ...(Object.keys(queryHidden).length > 0 ? { hidden: queryHidden } : {}),
      metadata: collectMetadata(source, search),
      ...extra,
    }),
    [publicId, queryHidden, source, search],
  )

  /** The session for saving and submitting; an anonymous form starts it now, with a bot-check token. */
  const ensureSession = useCallback((): Promise<ActiveSession> => {
    if (session.current) return Promise.resolve(session.current)
    starting.current ??= (async () => {
      const botToken = verification.current ? undefined : await bot.take()
      const result = await formsApi.startSession(
        publicId,
        startInput({ ...(botToken ? { botToken } : {}), ...(verification.current ? { verification: verification.current } : {}) }),
      )
      await applyStart(result, false)
      return session.current as ActiveSession
    })().finally(() => {
      starting.current = null
    })
    return starting.current
  }, [applyStart, bot, publicId, startInput])

  // Opening the page: count the view, then resume or start the personal session.
  useEffect(() => {
    const { key, fresh } = viewKey(publicId)
    if (fresh) void formsApi.recordView(publicId, { viewKey: key, source }).catch(() => undefined)

    let cancelled = false
    /** Picks up the session this browser stored; when that fails, the form starts over. */
    async function resumeStored() {
      const stored = loadStoredSession(publicId)
      if (!stored || !canResume(form)) return
      if (!cancelled) setPhase('resuming')
      try {
        const result = await formsApi.startSession(publicId, startInput({ resume: stored.session }))
        if (!cancelled) await applyStart(result, true)
      } catch {
        clearStoredSession(publicId)
        if (!cancelled) setPhase(initialPhase(form, undefined))
      }
    }
    async function open() {
      try {
        if (invitationToken) {
          const result = await formsApi.startSession(publicId, startInput({ invitationToken }))
          if (!cancelled) await applyStart(result, true)
          return
        }
        await resumeStored()
      } catch (err) {
        if (!cancelled) setPhase(openErrorPhase(err))
      }
    }
    void open()
    return () => {
      cancelled = true
    }
    // Once per page load (and again on "Try again").
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retry])

  const onVerified = useCallback(
    async (proof: string) => {
      verification.current = proof
      setPhase('resuming')
      try {
        const result = await formsApi.startSession(publicId, startInput({ verification: proof }))
        await applyStart(result, true)
      } catch {
        setPhase('error')
      }
    },
    [applyStart, publicId, startInput],
  )

  // ----- progress, uploads, submit -----

  const pending = useRef<{ lastBlockId: string; answers: Answers; timings: Record<string, number> } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flushProgress = useCallback(async () => {
    const p = pending.current
    pending.current = null
    if (timer.current) clearTimeout(timer.current)
    if (!p) return
    try {
      const active = await ensureSession()
      await formsApi.saveProgress(active.token, {
        lastBlockId: p.lastBlockId,
        // Answers are only kept when the form collects partial responses; do not send them otherwise.
        ...(form.collectPartial ? { answers: p.answers } : {}),
        timings: cleanTimings(p.timings),
      })
    } catch {
      // Progress is best effort; the submit carries everything.
    }
  }, [ensureSession, form.collectPartial])

  const onProgress = useCallback(
    (e: ProgressEvent) => {
      pending.current = { lastBlockId: e.lastBlockId, answers: e.answers, timings: sumTimings(pending.current?.timings, e.timings) }
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flushProgress(), PROGRESS_DEBOUNCE_MS)
    },
    [flushProgress],
  )

  const onUpload = useCallback(
    async (fieldId: string, file: File, onFraction?: (fraction: number) => void): Promise<FileAnswerItem> => {
      const active = await ensureSession()
      try {
        return await uploadFile(active.token, fieldId, file, onFraction)
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          session.current = null
          clearStoredSession(publicId)
          return uploadFile((await ensureSession()).token, fieldId, file, onFraction)
        }
        throw err
      }
    },
    [ensureSession, publicId],
  )

  const onSubmit = useCallback(
    async ({ answers, timings }: SubmitPayload): Promise<SubmitResult | SubmitFieldErrors> => {
      if (timer.current) clearTimeout(timer.current)
      const carried = pending.current?.timings
      pending.current = null
      const body = (): { answers: Answers; timings: Record<string, number>; website?: string } => ({
        answers,
        timings: cleanTimings(sumTimings(carried, timings)),
        ...(honeypot.current?.value ? { website: honeypot.current.value } : {}),
      })
      const attempt = async (): Promise<SubmitResult | SubmitFieldErrors> => {
        const active = await ensureSession()
        try {
          const result = await formsApi.submit(active.token, body())
          return result
        } catch (err) {
          if (err instanceof ApiError && err.status === 422 && err.code === 'VALIDATION_FAILED') {
            return { fieldErrors: (err.details?.fields ?? {}) as Record<string, AnswerError> }
          }
          throw err
        }
      }
      let outcome: SubmitResult | SubmitFieldErrors
      try {
        outcome = await attempt()
      } catch (err) {
        // The session ran out (or was never valid): start a new one and send once more.
        if (!(err instanceof ApiError && err.status === 401)) throw err
        session.current = null
        clearStoredSession(publicId)
        outcome = await attempt()
      }
      if (!('fieldErrors' in outcome)) clearStoredSession(publicId)
      return outcome
    },
    [ensureSession, publicId],
  )

  // Best effort: what is still waiting when the visitor leaves.
  useEffect(() => {
    const onHide = () => {
      if (pending.current) void flushProgress()
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [flushProgress])

  // ----- embed protocol -----

  const onEnding = useCallback(
    (result: SubmitResult) => {
      if (embed) postToHost('submitted', publicId, { responseId: result.responseId ?? '' })
    },
    [embed, publicId],
  )
  const onRedirect = useCallback(
    (url: string) => {
      if (!isSafeUrl(url)) return
      if (embed) postToHost('redirect', publicId, { url })
      else window.location.assign(url)
    },
    [embed, publicId],
  )

  useEffect(() => {
    if (!embed) return
    postToHost('ready', publicId, {})
    const el = shell.current
    let frame = 0
    const report = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (el) postToHost('height', publicId, { height: Math.ceil(el.getBoundingClientRect().height) })
      })
    }
    const observer = typeof ResizeObserver === 'undefined' || !el ? null : new ResizeObserver(report)
    if (el) observer?.observe(el)
    report()
    // Focus sits inside this frame, so the host page never sees Escape: pass it on.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && embed !== 'inline' && embed !== 'fullpage') postToHost('close', publicId, {})
    }
    document.addEventListener('keydown', onKey)
    return () => {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      document.removeEventListener('keydown', onKey)
    }
  }, [embed, publicId])

  // ----- render -----

  const openReport = () => setReporting(true)
  const dataEmbed = embed === 'inline' ? 'inline' : undefined
  const screen = (title: string, body?: string | null, children?: React.ReactNode) => (
    <MessageScreen title={title} body={body} form={form} embedded={embedded} onReport={openReport}>
      {children}
    </MessageScreen>
  )

  let content: React.ReactNode
  if (!definition) {
    content = screen(t.states.unpublished.title, t.states.unpublished.body)
  } else if (phase === 'completed') {
    content = screen(t.completed.title, t.completed.body)
  } else if (phase === 'invitation_revoked') {
    content = screen(t.invitation.revokedTitle, t.invitation.revokedBody)
  } else if (phase === 'invitation_invalid') {
    content = screen(t.invitation.invalidTitle, t.invitation.invalidBody)
  } else if (phase === 'error') {
    content = screen(
      t.error.title,
      t.error.body,
      <button
        type="button"
        className="mt-2 rounded-md border px-4 py-2 text-sm font-medium"
        onClick={() => {
          setPhase(initialPhase(form, invitationToken))
          setRetry((n) => n + 1)
        }}
      >
        {t.error.retry}
      </button>,
    )
  } else if (phase === 'resuming') {
    content = screen(t.loading)
  } else if (phase === 'verify') {
    content = (
      <div className="wf-page-shell" style={themeStyle(form.theme)} data-embed={dataEmbed}>
        <main className="flex flex-1 items-center justify-center p-6">
          <VerifyEmail publicId={publicId} takeBotToken={bot.take} onVerified={(proof) => void onVerified(proof)} />
        </main>
        <Footer showBadge={form.branding.showBadge} embedded={embedded} onReport={openReport} />
      </div>
    )
  } else {
    content = (
      <div ref={shell} className="wf-page-shell" style={themeStyle(form.theme)} data-embed={dataEmbed}>
        <FormRenderer
          key={rendererKey}
          definition={definition}
          theme={form.theme}
          seed={seed}
          embedded={embedded}
          mode="live"
          hidden={{ ...queryHidden, ...(start?.hidden ?? {}) }}
          labels={t.renderer}
          {...rendererStart(start)}
          onProgress={onProgress}
          onUpload={onUpload}
          onSubmit={onSubmit}
          onEnding={onEnding}
          onRedirect={onRedirect}
        />
        {/* A field real people never see: bots fill it in and the submit is refused. */}
        <input ref={honeypot} type="text" name="website" className="wf-honeypot" tabIndex={-1} autoComplete="off" aria-hidden="true" />
        <Footer showBadge={form.branding.showBadge} embedded={embedded} onReport={openReport} />
      </div>
    )
  }

  return (
    <>
      {content}
      {bot.node}
      <ReportDialog publicId={publicId} open={reporting} onClose={() => setReporting(false)} />
    </>
  )
}
