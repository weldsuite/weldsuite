import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@weldsuite/ui/components/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@weldsuite/ui/components/dialog'
import { Input } from '@weldsuite/ui/components/input'
import { Label } from '@weldsuite/ui/components/label'
import { Textarea } from '@weldsuite/ui/components/textarea'
import { formsApi } from '@/lib/client/api'
import { usePortal } from './portal-context'

const REASONS = ['phishing', 'spam', 'illegal', 'other'] as const
type Reason = (typeof REASONS)[number]

/** "Report abuse": a reason, optional details and email, sent to forms-api's report route. */
export function ReportDialog({ publicId, open, onClose }: Readonly<{ publicId: string; open: boolean; onClose: () => void }>) {
  const { t } = usePortal()
  const [reason, setReason] = useState<Reason>('phishing')
  const [details, setDetails] = useState('')
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [sent, setSent] = useState(false)

  useEffect(() => {
    if (open) {
      setReason('phishing')
      setDetails('')
      setEmail('')
      setBusy(false)
      setError(false)
      setSent(false)
    }
  }, [open])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(false)
    try {
      await formsApi.report(publicId, {
        reason,
        ...(details.trim() ? { details: details.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
      })
      setSent(true)
    } catch {
      setError(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent showCloseButton={false}>
        {sent ? (
          <div className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t.report.thanksTitle}</DialogTitle>
              <DialogDescription>{t.report.thanksBody}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                {t.report.close}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{t.report.title}</DialogTitle>
              <DialogDescription>{t.report.body}</DialogDescription>
            </DialogHeader>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{t.report.reasonLabel}</legend>
              {REASONS.map((value) => (
                <label key={value} className="flex items-start gap-2 text-sm">
                  <input type="radio" name="wf-report-reason" className="mt-1" checked={reason === value} onChange={() => setReason(value)} />
                  <span>{t.report.reasons[value]}</span>
                </label>
              ))}
            </fieldset>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wf-report-details">{t.report.detailsLabel}</Label>
              <Textarea
                id="wf-report-details"
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder={t.report.detailsPlaceholder}
                maxLength={2000}
                rows={3}
                className="text-base"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="wf-report-email">{t.report.emailLabel}</Label>
              <Input
                id="wf-report-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t.report.emailPlaceholder}
                maxLength={320}
                autoComplete="email"
              />
            </div>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {t.report.failed}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
                {t.report.cancel}
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : null}
                {busy ? t.report.submitting : t.report.submit}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
