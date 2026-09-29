/**
 * Support video: "How to add a DNS record" (WeldHost).
 * Embedded in src/app/weldhost/manage-dns-records/page.md.
 */
import { mockApi } from '../mock-api.mjs'
import { domain, zoneFor, dnsRecord } from './weldhost-fixtures.mjs'

const MAIN = domain('dom_example', 'example', 'com')
const DOMAINS = [
  MAIN,
  domain('dom_northfield', 'northfield-studio', 'example'),
  domain('dom_brightwave', 'brightwave', 'example', { registrar: 'Namecheap' }),
]
const ZONE = zoneFor(MAIN)

const RECORD = { type: 'CNAME', name: 'www', value: 'example.com' }

function initialRecords() {
  const z = ZONE.id
  return [
    dnsRecord(z, 'rec_a', 'A', '@', '203.0.113.10'),
    dnsRecord(z, 'rec_spf', 'TXT', '@', 'v=spf1 include:_spf.mx.example.net ~all', { lock: 'SPF record managed by WeldMail' }),
    dnsRecord(z, 'rec_mx1', 'MX', '@', 'route1.mx.example.net', { priority: 10, lock: 'MX record managed by WeldMail' }),
    dnsRecord(z, 'rec_mx2', 'MX', '@', 'route2.mx.example.net', { priority: 20, lock: 'MX record managed by WeldMail' }),
    dnsRecord(z, 'rec_dmarc', 'TXT', '_dmarc', 'v=DMARC1; p=none; rua=mailto:dmarc@example.com', { lock: 'DMARC record managed by WeldMail' }),
    dnsRecord(z, 'rec_verify', 'TXT', '@', 'site-verification=abc123xyz'),
  ]
}

function mockRoutes(page, env) {
  const records = initialRecords()
  const zoneMeta = () => ({ id: ZONE.id, syncedAt: ZONE.syncedAt, syncError: null })

  return mockApi(page, new URL(env.platformBase).origin, [
    [
      'GET /api/domains',
      () => ({
        domains: DOMAINS,
        pagination: { page: 1, pageSize: 10, total: DOMAINS.length, totalPages: 1 },
        stats: { total: DOMAINS.length, active: DOMAINS.length, pending: 0, expired: 0 },
      }),
    ],
    [/^GET \/api\/domains\/[^/]+$/, ({ url }) => ({ data: DOMAINS.find((d) => url.pathname.endsWith(d.id)) ?? MAIN })],
    [
      /^POST \/api\/domains\/[^/]+\/refresh-zone-status$/,
      () => ({ data: { zoneStatus: 'active', domainStatus: 'active', cloudflareStatus: 'active' } }),
    ],
    ['GET /api/dns-zones/by-domain/dom_example', () => ({ data: { ...ZONE, recordCount: records.length } })],
    ['GET /api/dns-records/by-domain/dom_example', () => ({ data: { records, zone: zoneMeta() } })],
    [
      'POST /api/dns-records/by-domain/dom_example',
      ({ json }) => {
        records.push(
          dnsRecord(ZONE.id, `rec_${records.length + 1}`, json.type, json.name, json.value, {
            ttl: json.ttl ?? 3600,
            priority: json.priority ?? null,
          }),
        )
        return { data: { records } }
      },
    ],
  ])
}

async function run(d, page) {
  await d.pause(700)

  await d.caption('Open WeldHost → Domains and select your domain. The DNS tab opens first')
  await d.click(page.getByText(MAIN.fullDomain, { exact: true }).first())
  await page.getByRole('button', { name: 'Add Record' }).waitFor({ state: 'visible' })
  await d.pause(900)

  await d.caption('Expand the panel for more room')
  await d.click(page.getByRole('button', { name: 'Expand' }))
  await d.pause(900)

  await d.caption('The DNS tab lists all records. Click Add Record')
  await d.click(page.getByRole('button', { name: 'Add Record' }))
  await page.getByText('New record', { exact: false }).first().waitFor({ state: 'visible' })
  await d.pause(600)

  await d.caption('Choose a Type: CNAME')
  await d.click(page.getByRole('combobox').first())
  await d.click(page.getByRole('option', { name: RECORD.type, exact: true }))

  await d.caption('Enter the Name: www')
  await d.type(page.getByLabel('Name', { exact: false }).first(), RECORD.name, { delay: 110 })

  await d.caption('Enter the Value the provider gave you')
  await d.type(page.getByLabel('Value', { exact: false }).first(), RECORD.value, { delay: 80 })
  await d.pause(700)

  await d.caption('Leave TTL at the default, then save the record')
  await d.click(page.getByRole('button', { name: 'Add Record' }).last())
  await page.getByText('www', { exact: true }).first().waitFor({ state: 'visible' })
  await d.pause(1800)

  await d.caption('The new record now appears in the DNS table', { numbered: false })
  await d.pause(2200)
  await d.hideCaption()
}

export default {
  name: 'weldhost-manage-dns-records',
  url: (env) => `${env.platformBase}/preview/weldhost/domains`,
  readySelector: `text=${MAIN.fullDomain}`,
  intro: { eyebrow: 'WeldHost', title: 'How to add a DNS record', subtitle: 'Point a name at a server, alias or service' },
  outro: { eyebrow: 'WeldHost', title: "That's it!", subtitle: 'More guides at help.weldsuite.org' },
  mockRoutes,
  run,
}
