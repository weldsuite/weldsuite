import { usePortal } from './portal-context'

interface FooterProps {
  showBadge: boolean
  /** In an embed only the password line stays. */
  embedded: boolean
  onReport: () => void
}

/** Under every public form: the phishing warning, the report link and (when the plan shows it) the badge. */
export function Footer({ showBadge, embedded, onReport }: Readonly<FooterProps>) {
  const { t } = usePortal()
  return (
    <footer className="wf-footer">
      <span>{t.footer.passwords}</span>
      {embedded ? null : (
        <>
          <button type="button" onClick={onReport}>
            {t.footer.report}
          </button>
          {showBadge ? (
            <a href="https://weldsuite.org" target="_blank" rel="noopener noreferrer">
              {t.footer.badge}
            </a>
          ) : null}
        </>
      )}
    </footer>
  )
}
