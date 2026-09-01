import { Heading } from '@/components/Heading'
import { ResourceVersionBanner } from '@/components/VersionContent'
import { Col, Properties, Property, Row } from '@/components/mdx'
import type { CrudResourceDocConfig } from '@/lib/weldbooks-resource-configs'

const API_BASE = 'https://api.weldsuite.org/v1'

function PropertyList({ items }: { items: CrudResourceDocConfig['modelProperties'] }) {
  return (
    <Properties>
      {items.map((p) => (
        <Property key={p.name} name={p.name} type={p.type}>
          {p.description}
        </Property>
      ))}
    </Properties>
  )
}

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

export function CrudResourcePage({ config }: { config: CrudResourceDocConfig }) {
  const path = `${API_BASE}/${config.endpoint}`
  const exampleId = `${config.idPrefix}_abc123`
  const newId = `${config.idPrefix}_new456`
  const listCurl = `curl -G ${path} \\
  -H "Authorization: Bearer wsk_your_api_key"`
  const getCurl = `curl ${path}/${exampleId} \\
  -H "Authorization: Bearer wsk_your_api_key"`
  const createCurl = `curl ${path} \\
  -H "Authorization: Bearer wsk_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{}'`
  const patchCurl = `curl -X PATCH ${path}/${exampleId} \\
  -H "Authorization: Bearer wsk_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '{}'`
  const deleteCurl = `curl -X DELETE ${path}/${exampleId} \\
  -H "Authorization: Bearer wsk_your_api_key"`

  return (
    <>
      <h1>{config.title}</h1>
      <p className="lead">{config.lead}</p>
      <ResourceVersionBanner />

      <hr />

      <Heading level={2} id="the-model" anchor={false}>
        The {config.resourceSingular} model
      </Heading>

      <Heading level={3} id="properties" anchor={false}>
        Properties
      </Heading>
      <PropertyList items={config.modelProperties} />

      <hr />

      <Heading level={2} id="list" tag="GET" label={`/v1/${config.endpoint}`}>
        List {config.title.toLowerCase()}
      </Heading>
      <Row>
        <Col>
          <p>Retrieve a cursor-paginated list.</p>
          {config.listQueryNote && <p>{config.listQueryNote}</p>}
        </Col>
        <Col sticky>
          <CodeBlock title="Request" tag="GET" label={`/v1/${config.endpoint}`}>
            {listCurl}
          </CodeBlock>
          <JsonBlock>{`{
  "data": [
    { "id": "${exampleId}" }
  ],
  "pagination": { "totalCount": 1, "hasMore": false, "cursor": null }
}`}</JsonBlock>
        </Col>
      </Row>

      <hr />

      <Heading level={2} id="create" tag="POST" label={`/v1/${config.endpoint}`}>
        Create a {config.resourceSingular}
      </Heading>
      <Row>
        <Col>
          <p>Create a {config.resourceSingular}.</p>
          {config.createRequired && config.createRequired.length > 0 && (
            <>
              <Heading level={3} id="required-attributes" anchor={false}>
                Required attributes
              </Heading>
              <PropertyList items={config.createRequired} />
            </>
          )}
          {config.createOptionalNote && <p>{config.createOptionalNote}</p>}
          {config.extraNotes && <p>{config.extraNotes}</p>}
        </Col>
        <Col sticky>
          <CodeBlock title="Request" tag="POST" label={`/v1/${config.endpoint}`}>
            {createCurl}
          </CodeBlock>
          <JsonBlock>{`{
  "data": {
    "id": "${newId}",
    "createdAt": "2024-12-01T14:00:00Z",
    "updatedAt": "2024-12-01T14:00:00Z"
  }
}`}</JsonBlock>
        </Col>
      </Row>

      <hr />

      <Heading level={2} id="retrieve" tag="GET" label={`/v1/${config.endpoint}/:id`}>
        Retrieve a {config.resourceSingular}
      </Heading>
      <Row>
        <Col>
          <p>Retrieve a single {config.resourceSingular} by ID.</p>
        </Col>
        <Col sticky>
          <CodeBlock title="Request" tag="GET" label={`/v1/${config.endpoint}/${exampleId}`}>
            {getCurl}
          </CodeBlock>
          <JsonBlock>{`{
  "data": {
    "id": "${exampleId}"
  }
}`}</JsonBlock>
        </Col>
      </Row>

      <hr />

      <Heading level={2} id="update" tag="PATCH" label={`/v1/${config.endpoint}/:id`}>
        Update a {config.resourceSingular}
      </Heading>
      <Row>
        <Col>
          <p>Partially update a {config.resourceSingular}. Only sent fields are changed.</p>
        </Col>
        <Col sticky>
          <CodeBlock title="Request" tag="PATCH" label={`/v1/${config.endpoint}/${exampleId}`}>
            {patchCurl}
          </CodeBlock>
          <JsonBlock>{`{
  "data": {
    "id": "${exampleId}",
    "updatedAt": "2024-12-01T15:00:00Z"
  }
}`}</JsonBlock>
        </Col>
      </Row>

      <hr />

      <Heading level={2} id="delete" tag="DELETE" label={`/v1/${config.endpoint}/:id`}>
        Delete a {config.resourceSingular}
      </Heading>
      <Row>
        <Col>
          <p>
            Soft-delete a {config.resourceSingular}. Returns <code>204 No Content</code>.
          </p>
        </Col>
        <Col sticky>
          <CodeBlock title="Request" tag="DELETE" label={`/v1/${config.endpoint}/${exampleId}`}>
            {deleteCurl}
          </CodeBlock>
          <JsonBlock>{`204 No Content`}</JsonBlock>
        </Col>
      </Row>
    </>
  )
}
