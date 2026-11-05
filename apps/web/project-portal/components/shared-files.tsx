import { useState } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { Button } from '@weldsuite/ui/components/button'
import type { PortalDocument, PortalFile } from '@weldsuite/app-api-client/schemas/project-portal'
import { loadDocuments, loadFiles, type Outcome, type Page } from '@/lib/portal'
import { usePortal } from '@/components/portal-context'
import { EmptyText, Section } from '@/components/ui-bits'

type Kind = 'documents' | 'files'

interface Row {
  id: string
  name: string
  meta: string
}

/** The download is a server route of this app: it adds the session, so the link is a plain one. */
function downloadHref(workspace: string, projectId: string, kind: Kind, id: string): string {
  return `/${encodeURIComponent(workspace)}/download/${encodeURIComponent(projectId)}/${kind}/${encodeURIComponent(id)}`
}

/** A list that starts as the first page the loader fetched and grows with "Show more". */
function useGrowingList<T extends { id: string }>(
  first: Page<T>,
  fetchMore: (cursor: string) => Promise<Outcome<Page<T>>>,
) {
  const [items, setItems] = useState<T[]>(first.items)
  const [paging, setPaging] = useState({ cursor: first.cursor, hasMore: first.hasMore })
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)

  async function more() {
    if (!paging.cursor || loading) return
    setLoading(true)
    setFailed(false)
    try {
      const result = await fetchMore(paging.cursor)
      if (!result.ok) {
        setFailed(true)
        return
      }
      setItems((current) => {
        const known = new Set(current.map((item) => item.id))
        return [...current, ...result.data.items.filter((item) => !known.has(item.id))]
      })
      setPaging({ cursor: result.data.cursor, hasMore: result.data.hasMore })
    } finally {
      setLoading(false)
    }
  }

  return { items, hasMore: paging.hasMore, loading, failed, more }
}

function FileList({
  rows,
  workspace,
  projectId,
  kind,
  hasMore,
  loading,
  failed,
  onMore,
  heading,
}: Readonly<{
  rows: Row[]
  workspace: string
  projectId: string
  kind: Kind
  hasMore: boolean
  loading: boolean
  failed: boolean
  onMore: () => void
  heading?: string
}>) {
  const { t, fill } = usePortal()
  const d = t.project.documents
  return (
    <div>
      {heading && <h3 className="mb-1 text-xs font-medium text-muted-foreground">{heading}</h3>}
      <ul className="flex flex-col">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-2.5 border-t py-2.5 first:border-t-0">
            <span
              aria-hidden="true"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
            >
              <FileText className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <a
                href={downloadHref(workspace, projectId, kind, row.id)}
                download
                aria-label={fill(d.download, { name: row.name })}
                className="block truncate text-[13px] font-medium underline-offset-2 hover:underline focus-visible:underline"
              >
                {row.name}
              </a>
              <p className="truncate text-xs text-muted-foreground">{row.meta}</p>
            </div>
          </li>
        ))}
      </ul>
      {failed && (
        <p role="alert" className="mt-1 text-sm text-destructive">
          {d.failed}
        </p>
      )}
      {(hasMore || loading) && (
        <Button type="button" variant="outline" size="sm" className="mt-2" disabled={loading} onClick={onMore}>
          {loading && <Loader2 className="animate-spin" aria-hidden="true" />}
          {d.showMore}
        </Button>
      )}
    </div>
  )
}

/**
 * What the team shared as documents (WeldDocs) and files: each one downloads
 * through this app, which sends the contact's session along.
 */
export function SharedFiles({
  workspace,
  projectId,
  documents,
  files,
  className,
}: Readonly<{
  workspace: string
  projectId: string
  documents: Page<PortalDocument>
  files: Page<PortalFile>
  className?: string
}>) {
  const { t, fill, format } = usePortal()
  const d = t.project.documents
  const docs = useGrowingList(documents, async (cursor) => loadDocuments({ data: { workspace, projectId, cursor } }))
  const fls = useGrowingList(files, async (cursor) => loadFiles({ data: { workspace, projectId, cursor } }))

  const documentRows: Row[] = docs.items.map((doc) => ({
    id: doc.id,
    name: doc.name,
    meta: fill(d.shared, { date: format.date(doc.updatedAt || doc.createdAt) }),
  }))
  const fileRows: Row[] = fls.items.map((file) => ({
    id: file.id,
    name: file.name,
    meta: [
      file.uploadedByName
        ? fill(d.sharedBy, { date: format.date(file.createdAt), name: file.uploadedByName })
        : fill(d.shared, { date: format.date(file.createdAt) }),
      format.bytes(file.size),
    ].join(' · '),
  }))

  const both = documentRows.length > 0 && fileRows.length > 0
  return (
    <Section title={d.title} className={className}>
      {documentRows.length === 0 && fileRows.length === 0 ? (
        <EmptyText>{d.empty}</EmptyText>
      ) : (
        <div className="flex flex-col gap-4">
          {documentRows.length > 0 && (
            <FileList
              rows={documentRows}
              workspace={workspace}
              projectId={projectId}
              kind="documents"
              hasMore={docs.hasMore}
              loading={docs.loading}
              failed={docs.failed}
              onMore={() => void docs.more()}
              heading={both ? d.documents : undefined}
            />
          )}
          {fileRows.length > 0 && (
            <FileList
              rows={fileRows}
              workspace={workspace}
              projectId={projectId}
              kind="files"
              hasMore={fls.hasMore}
              loading={fls.loading}
              failed={fls.failed}
              onMore={() => void fls.more()}
              heading={both ? d.files : undefined}
            />
          )}
        </div>
      )}
    </Section>
  )
}
