/**
 * Support video: "How to connect an external domain" (WeldHost).
 * Embedded in src/app/weldhost/connect-external-domain/page.md.
 *
 * Registrar-side steps (adding the TXT record, changing nameservers) happen in
 * another company's UI and are not shown or faked: the video ends on the
 * nameserver values WeldHost tells you to set there.
 */
import { mockApi } from '../mock-api.mjs'
import { domain, NAMESERVERS } from './weldhost-fixtures.mjs'

const NEW_DOMAIN = { name: 'northwind-studio', tld: 'example', registrar: 'Namecheap' }
const FULL = `${NEW_DOMAIN.name}.${NEW_DOMAIN.tld}`

const EXISTING = [
  domain('dom_example', 'example', 'com'),
  domain('dom_brightwave', 'brightwave', 'example', { registrar: 'Namecheap' }),
]

const VERIFICATION = { name: `_weldhost-verify.${FULL}`, type: 'TXT', value: 'weldhost-verify=8f3a1c72d94b40e6' }

const SCANNED = [
  { type: 'A', name: FULL, value: '198.51.100.24', ttl: 3600 },
  { type: 'CNAME', name: `www.${FULL}`, value: FULL, ttl: 3600 },
  { type: 'MX', name: FULL, value: 'mail.northwind-studio.example', ttl: 3600, priority: 10 },
  { type: 'TXT', name: FULL, value: 'v=spf1 include:_spf.mail.example.net ~all', ttl: 3600 },
]

function mockRoutes(page, env) {
  const added = domain('dom_northwind', NEW_DOMAIN.name, NEW_DOMAIN.tld, {
    status: 'pending',
    registrar: NEW_DOMAIN.registrar,
    nameserverVerified: false,
    nameserverVerificationPending: true,
    nameservers: [],
  })
  let domains = [...EXISTING]

  return mockApi(page, new URL(env.platformBase).origin, [
    [
      'GET /api/domains',
      () => ({
        domains,
        pagination: { page: 1, pageSize: 10, total: domains.length, totalPages: 1 },
        stats: { total: domains.length, active: domains.length, pending: 0, expired: 0 },
      }),
    ],
    [
      'POST /api/domains/external',
      () => {
        domains = [...EXISTING, added]
        return { data: { ...added, verificationRecord: VERIFICATION } }
      },
    ],
    [
      'POST /api/domains/dom_northwind/verify-ownership',
      () => ({
        data: {
          ...added,
          status: 'pending',
          nameservers: NAMESERVERS,
          dnsZone: { id: 'zone_dom_northwind', externalZoneId: 'cf_dom_northwind', externalNameservers: NAMESERVERS },
        },
      }),
    ],
    ['POST /api/dns-records/by-domain/dom_northwind/scan', () => ({ data: { records: SCANNED } })],
    [
      'POST /api/dns-records/by-domain/dom_northwind/import',
      ({ json }) => ({ data: { imported: json?.records?.length ?? 0, skipped: 0, failed: [] } }),
    ],
  ])
}

async function run(d, page) {
  await d.pause(700)

  await d.caption('Open WeldHost → Domains and click Add External Domain')
  await d.click(page.getByRole('button', { name: 'Add External Domain' }))
  await page.getByPlaceholder('example.com').waitFor({ state: 'visible' })
  await d.pause(700)

  await d.caption('Enter the full domain name')
  await d.type(page.getByPlaceholder('example.com'), FULL, { delay: 80 })

  await d.caption('Optionally note where it is registered, then continue')
  await d.type(page.getByPlaceholder(/GoDaddy/), NEW_DOMAIN.registrar, { delay: 80 })
  await d.pause(500)
  await d.click(page.getByRole('button', { name: 'Continue' }))
  await page.getByText('Add this TXT record').first().waitFor({ state: 'visible' })
  await d.pause(1200)

  await d.caption('Add this TXT record at your current DNS provider to prove ownership', { holdMs: 3200 })
  await d.caption('Then click Verify ownership')
  await d.click(page.getByRole('button', { name: 'Verify ownership' }))
  await page.getByText('Existing DNS Records').first().waitFor({ state: 'visible' })
  await d.pause(1400)

  await d.caption('Select the existing DNS records to copy, so nothing breaks at switch-over')
  // Toasts pause while hovered; park the cursor on the list so it can clear.
  await page.mouse.move(520, 380, { steps: 25 })
  await page.getByText('Domain ownership verified').waitFor({ state: 'hidden', timeout: 15000 })
  await d.pause(600)
  await d.click(page.getByRole('button', { name: 'Import 4 records' }))
  await page.getByText('Cloudflare Nameservers').first().waitFor({ state: 'visible' })
  await d.pause(1200)

  await d.caption('Set these nameservers at your registrar. WeldHost shows them here', { holdMs: 3800 })
  await page.mouse.move(640, 300, { steps: 25 })
  await d.pause(3200)
  await d.hideCaption()
}

export default {
  name: 'weldhost-connect-external-domain',
  url: (env) => `${env.platformBase}/preview/weldhost/domains`,
  readySelector: 'text=example.com',
  intro: { eyebrow: 'WeldHost', title: 'How to connect an external domain', subtitle: 'Manage a domain registered elsewhere in WeldHost' },
  outro: { eyebrow: 'WeldHost', title: "That's it!", subtitle: 'More guides at help.weldsuite.org' },
  mockRoutes,
  run,
}
