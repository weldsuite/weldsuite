import { Heading } from '@/components/Heading'
import { ResourceVersionBanner } from '@/components/VersionContent'
import { Col, Properties, Property, Row } from '@/components/mdx'

const PATH = 'https://api.weldsuite.org/v1/accounting-settings'

function CodeBlock({ title, tag, label, children }: { title: string; tag: string; label: string; children: string }) {
  return (
    <div className="my-6 overflow-hidden rounded-2xl bg-zinc-900 shadow-md dark:ring-1 dark:ring-white/10">
      <div className="flex h-9 items-center gap-2 border-b border-white/7.5 bg-zinc-900 px-4">
        <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 font-mono text-xs text-emerald-400 ring-1 ring-emerald-500/20">
          {tag}
        </span>
        <span className="h-0.5 w-0.5 rounded-full bg-zinc-500" />
        <span className="font-mono text-xs text-zinc-400">{label}</span>
      </div>
      <div className="border-b border-white/7.5 px-4 py-2 text-xs font-semibold text-white">{title}</div>
      <pre className="overflow-x-auto p-4 text-xs text-white">
        <code>{children}</code>
      </pre>
    </div>
  )
}

function JsonBlock({ children }: { children: string }) {
  return (
    <div className="my-6 overflow-hidden rounded-2xl bg-zinc-900 shadow-md dark:ring-1 dark:ring-white/10">
      <pre className="overflow-x-auto p-4 text-xs text-white">
        <code>{children}</code>
      </pre>
    </div>
  )
}

export function AccountingSettingsPage() {
  const getCurl = `curl ${PATH} \\
  -H "Authorization: Bearer wsk_your_api_key"`
  const patchCurl = `curl -X PATCH ${PATH} \\
  -H "Authorization: Bearer wsk_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{ "defaultPaymentTermsDays": 14 }'`

  return (
    <>
      <h1>Accounting settings</h1>
      <p className="lead">
        Workspace-wide WeldBooks defaults (singleton row). There is at most one settings record per
        workspace. Mutations require <code>accounting_settings:write</code>; reads require{' '}
        <code>accounting_settings:read</code>.
      </p>
      <ResourceVersionBanner />

      <hr />

      <Heading level={2} id="the-model" anchor={false}>
        The settings model
      </Heading>
      <Properties>
        <Property name="id" type="string">
          Unique identifier (e.g. <code>acs_abc123</code>).
        </Property>
        <Property name="defaultEntityId" type="string">
          Default accounting entity for new documents.
        </Property>
        <Property name="fiscalYearStart" type="number">
          Month the fiscal year starts (1–12).
        </Property>
        <Property name="accountingMethod" type="string">
          <code>accrual</code> or <code>cash</code>.
        </Property>
        <Property name="defaultPaymentTermsDays" type="number">
          Default payment terms in days.
        </Property>
        <Property name="emailSettings" type="object">
          Inbox automation settings for document scanning.
        </Property>
        <Property name="updatedAt" type="timestamp">
          When last updated.
        </Property>
      </Properties>

      <hr />

      <Heading level={2} id="retrieve" tag="GET" label="/v1/accounting-settings">
        Retrieve settings
      </Heading>
      <Row>
        <Col>
          <p>
            Returns the workspace settings row. If none exists yet, the API creates a default row
            and returns it with <code>201</code>.
          </p>
        </Col>
        <Col sticky>
          <CodeBlock title="Request" tag="GET" label="/v1/accounting-settings">
            {getCurl}
          </CodeBlock>
          <JsonBlock>{`{
  "data": {
    "id": "acs_abc123",
    "defaultPaymentTermsDays": 30,
    "accountingMethod": "accrual",
    "fiscalYearStart": 1
  }
}`}</JsonBlock>
        </Col>
      </Row>

      <hr />

      <Heading level={2} id="update" tag="PATCH" label="/v1/accounting-settings">
        Update settings
      </Heading>
      <Row>
        <Col>
          <p>Partially update workspace accounting settings. Only sent fields are changed.</p>
          <Properties>
            <Property name="defaultEntityId" type="string">
              Default entity id.
            </Property>
            <Property name="fiscalYearStart" type="number">
              Fiscal year start month.
            </Property>
            <Property name="accountingMethod" type="string">
              Accrual or cash.
            </Property>
            <Property name="defaultPaymentTermsDays" type="number">
              Default payment terms.
            </Property>
            <Property name="emailSettings" type="object">
              Inbox / OCR automation toggles.
            </Property>
          </Properties>
        </Col>
        <Col sticky>
          <CodeBlock title="Request" tag="PATCH" label="/v1/accounting-settings">
            {patchCurl}
          </CodeBlock>
          <JsonBlock>{`{
  "data": {
    "id": "acs_abc123",
    "defaultPaymentTermsDays": 14,
    "updatedAt": "2024-12-01T15:00:00Z"
  }
}`}</JsonBlock>
        </Col>
      </Row>
    </>
  )
}
