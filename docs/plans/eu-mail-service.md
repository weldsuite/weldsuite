# WeldSuite MTA: own mail service for the EU edition

Status: in progress (2026-11-07). Supersedes the outbound half of ADR MAIL-010
(an external EU relay) with ADR MAIL-011: the EU edition sends its own mail
from its own Hetzner IPs, through an MTA written in this repo.

Decided with Gert (2026-11-07):

- **Own MTA, direct delivery.** No external relay. Outbound port 25 on the
  mail nodes must be unblocked by Hetzner support (after the first paid
  invoice); new IPs warm up on a schedule.
- **Built from the ground up, in Rust**, inside the one `weldsuite` binary
  (`weldsuite mta`, code in `rust/crates/mta`). No mail or DNS libraries:
  SMTP server and client, DNS stub resolver, DKIM signing, DSN/ARF parsing,
  MTA-STS and TLS-RPT are ours. Only the workspace's base crates (tokio,
  rustls, aws-lc-rs, sqlx, async-nats, serde, reqwest for the MTA-STS policy
  fetch).
- **The return path is ours too.** Bounces (DSNs) and complaint reports (ARF)
  come back to the MTA's own port 25 listener for the bounce domain. Haraka
  stays the MX for WeldMail mailboxes only and is not involved.
- **Mail nodes in the EU Talos cluster**, like the LiveKit nodes: dedicated
  Hetzner servers, each with its own primary IPv4 and reverse DNS, the MTA on
  `hostNetwork` so it sends from the node's public IP.
- **Separate IP pools**: `system` (transactional: calendar, digests,
  invites) and `customer` (WeldMail and every other user-written mail). A pool
  is a set of mail nodes; a node delivers only for its pool.
- **Queue in its own Postgres database** (`weldsuite_mta` on the
  CloudNativePG cluster), with the MTA's own SQL migrations, run by
  `weldsuite mta` under an advisory lock.
- **One PR** for the whole thing: MTA, server wiring, chart, OpenTofu, Flux EU
  values, docs.

## Contract

Everything below is the interface between the MTA (`rust/crates/mta`), the
server (`bins/weldsuite`), the Helm chart and the OpenTofu config. Change it
here first.

### Commands

| Command | What |
|---|---|
| `weldsuite mta` (or `weldsuite mta run`) | Migrate, then run submission, the bounce MX, the HTTP API, delivery workers, the event outbox publisher and housekeeping |
| `weldsuite mta migrate` | Apply the MTA migrations and exit |
| `weldsuite mta domains add <domain> [--pool <pool>]...` | Register a sending domain, print its DKIM record |
| `weldsuite mta domains list` / `show <domain>` / `remove <domain>` | |
| `weldsuite mta queue` | Queue counts by pool and status |

### Environment

| Variable | Secret | Default | Meaning |
|---|---|---|---|
| `MTA_DATABASE_URL` | yes | required | The MTA's own database (`weldsuite_mta`) |
| `MTA_KEY` | yes | required | base64 of 32 bytes. AES-256-GCM key for DKIM private keys at rest; HKDF-derives the VERP tag key |
| `MTA_API_SECRET` | yes | required for `run` | Bearer token for the HTTP API |
| `MTA_SUBMISSION_PASSWORD_<POOL>` | yes | at least one | Defines pool `<pool>` (lowercased) and its submission password. Username = pool name. Chart: `..._SYSTEM`, `..._CUSTOMER`. Use URL-safe values (hex) |
| `MTA_POOLS` | no | required for `run` | Comma list of pools this node delivers for |
| `MTA_SUBMISSION_ADDR` | no | `0.0.0.0:2587` | Submission listener (private network only). Chart: `$(HOST_IP):2587` |
| `MTA_SUBMISSION_TLS_CERT` / `_KEY` | no | empty | PEM paths; set both to offer STARTTLS on submission |
| `MTA_API_ADDR` | no | `0.0.0.0:8025` | HTTP API. Chart: `$(HOST_IP):8025` |
| `MTA_INBOUND_ADDR` | no | empty (off) | The bounce MX listener. Chart on mail nodes: `0.0.0.0:25` (needs `NET_BIND_SERVICE`) |
| `MTA_INBOUND_TLS_CERT` / `_KEY` | no | empty | PEM paths for STARTTLS on the bounce MX |
| `MTA_BOUNCE_DOMAIN` | no | empty | Return-path domain (`bounces.<domain>`). Empty: the sender's own MAIL FROM is kept and only synchronous bounces are seen |
| `MTA_HOSTNAME` | no | PTR of the source IP | EHLO name, must match the IP's reverse DNS |
| `MTA_SOURCE_IP` | no | auto-detected | Public IPv4 outbound connections bind to |
| `MTA_RESOLVER` | no | first `nameserver` in `/etc/resolv.conf` | `ip:port` of the DNS resolver |
| `MTA_MAX_MESSAGE_BYTES` | no | `26214400` | Largest accepted message |
| `MTA_MAX_QUEUE_AGE` | no | `5d` | After this a deferred recipient bounces (`5d`, `36h`, `90m`) |
| `MTA_CONCURRENCY` | no | `32` | Parallel outbound connections per node |
| `MTA_WARMUP_SCHEDULE` | no | `50,100,200,400,800,1500,3000,6000,12000,25000,50000` | Per-IP daily cap on warm-up day 1, 2, …; unlimited after the last. `off` disables |
| `MTA_SUPPRESS_DAYS` | no | `30` | A hard-bounced recipient is refused at submission (`550 5.1.1`) for this long, per pool |
| `MTA_TLSRPT_FROM` | no | `tlsrpt-noreply@<MTA_BOUNCE_DOMAIN>` | Sender of TLS-RPT reports (system pool). Empty bounce domain: no reports |
| `NATS_URL`, `NATS_USER`, `NATS_PASSWORD`, `NATS_TOKEN` | yes | empty | Delivery events. Without `NATS_URL` events stay in the outbox table |
| `MTA_EVENTS_SUBJECT` | no | `mail.sending-events` | Subject events are published on (stream `MAIL_SENDING_EVENTS`, created by `weldsuite consume`) |
| `LOG_FORMAT` | no | as the server | |

### Submission (SMTP, port 2587, Service port 587)

- ESMTP with `PIPELINING`, `8BITMIME`, `SMTPUTF8`, `SIZE`, `ENHANCEDSTATUSCODES`,
  `AUTH PLAIN LOGIN`, `STARTTLS` when configured. AUTH is required before
  `MAIL`; the username picks the pool.
- Any node accepts submissions for any pool (one `Service` for all mail
  nodes); delivery happens on the pool's own nodes.
- Answers the server's `smtp_transport.rs` maps to Cloudflare codes:
  - recipient hard-bounced in this pool within `MTA_SUPPRESS_DAYS`:
    `550 5.1.1 recipient suppressed` (`E_RECIPIENT_SUPPRESSED`)
  - header From domain (or MAIL FROM domain) has no DKIM key usable by the
    pool: `550 5.7.1 sender domain not authorised` (`E_SENDER_NOT_VERIFIED`)
  - database unavailable: `451 4.3.0`
- `250 2.0.0 queued as <id>` only after the message and its recipients are
  committed to the database.
- Connection strings for the server:
  `SMTP_URL=smtp://system:<pw>@<release>-mta.<ns>.svc:587`,
  `MAIL_SMTP_URL=smtp://customer:<pw>@<release>-mta.<ns>.svc:587`.

### Delivery

- Recipients grouped by destination domain; MX lookup (null MX → bounce,
  no MX → A fallback), IPv4 only, from `MTA_SOURCE_IP`, EHLO `MTA_HOSTNAME`.
- Opportunistic STARTTLS; MTA-STS `enforce` policies require a matching MX and
  a valid certificate (`testing`: recorded only). Outcomes feed TLS-RPT.
- Retries: 5m, 15m, 30m, 1h, 2h, 4h, then every 6h until `MTA_MAX_QUEUE_AGE`.
- Shaping per provider (Google, Microsoft, Yahoo, Apple, GMX/Web.de, other)
  and the warm-up cap per source IP per day; a capped send waits, it does not
  count as an attempt.
- With `MTA_BOUNCE_DOMAIN` the envelope sender becomes
  `b+<recipient id>-<tag>@<bounce domain>` (tag = HMAC of the id), the
  message is DKIM-signed for the header From domain, and gets
  `Feedback-ID: <pool>:<From domain>:weldsuite` and `X-WeldSuite-Mta-Id: <recipient id>`
  (stripped from nothing; kept for ARF matching).

### Bounce MX (port 25 on the mail nodes, MX of `MTA_BOUNCE_DOMAIN`)

- Accepts only `b+<id>-<tag>@`, `fbl@`, `postmaster@`, `abuse@` at the bounce
  domain; everything else `550 5.1.1`. DSNs (`multipart/report;
  report-type=delivery-status`) and ARF (`report-type=feedback-report`) are
  parsed; anything else is logged and dropped.

### Delivery events (NATS, `mail.sending-events`)

Cloudflare Email Sending's shape, which
`crates/mail-domain/src/outbound/delivery_events.rs` parses:

```json
{
  "type": "cf.email.sending.message.bounced",
  "metadata": { "eventTimestamp": "2026-11-07T12:00:00.000Z" },
  "payload": {
    "sender": "anna@acme.eu",
    "recipient": "bob@example.com",
    "bounce": { "type": "hard" },
    "delivery": { "smtpResponse": "550 5.1.1 user unknown" }
  }
}
```

Types: `delivered`, `deferred` (first deferral only), `bounced` (`hard` /
`soft`), `complained` (`complaint.type`). Written to an outbox table in the
same transaction as the state change, published with a JetStream ack, at
least once.

### HTTP API (port 8025, `Authorization: Bearer <MTA_API_SECRET>`)

| Route | |
|---|---|
| `GET /healthz` | No auth. 200 when the process runs |
| `GET /readyz` | No auth. 200 when the database answers |
| `POST /v1/domains` `{ "domain", "pools"?: ["customer"] }` | Register (idempotent) → 200/201 `Domain` |
| `GET /v1/domains` | `{ "data": [Domain] }` |
| `GET /v1/domains/{domain}` | `Domain` or 404 |
| `DELETE /v1/domains/{domain}` | 204 |
| `GET /v1/queue` | Counts by pool and status |

`Domain`:
```json
{
  "domain": "acme.eu",
  "selector": "ws202611",
  "algorithm": "rsa-sha256",
  "publicKey": "<base64 SubjectPublicKeyInfo>",
  "dkim": { "name": "ws202611._domainkey.acme.eu", "type": "TXT", "value": "v=DKIM1; k=rsa; p=…" },
  "pools": ["customer"],
  "createdAt": "2026-11-07T12:00:00.000Z"
}
```

`pools` empty = any pool. The server registers customer domains with
`["customer"]`; operators register the system domain with `--pool system`.

### Server wiring (`bins/weldsuite`)

Variables the server and consume read (besides `SMTP_URL` / `MAIL_SMTP_URL`):
`MTA_API_URL`, `MTA_API_SECRET`, `MAIL_MX_HOST` (Haraka's name; without it no
domain adapter), `MAIL_SPF_INCLUDE` (`_spf.<domain>`), optional
`MAIL_DMARC_RECORD`, `MAIL_DNS_RESOLVER`; consume: `NATS_MAIL_SENDING_EVENTS_STREAM`
/ `_SUBJECT` / `_DLQ_STREAM` (defaults `MAIL_SENDING_EVENTS`,
`mail.sending-events`, `MAIL_SENDING_EVENTS_DLQ`) and `VALKEY_URL` with
`VALKEY_LEDGER_PREFIX` for the outbound ledger. The Rust backend does not
serve `/api/mail-domains` yet: the adapter is built and held in
`MailState::domains`, and porting those routes is follow-up work.

- `MTA_API_URL` + `MTA_API_SECRET`: `RelayDomains` over an `MtaDomainApi`
  (`RelayDomainApi` in `crates/mail-domain/src/domains.rs`) for the mail
  domain routes. Unset: `ManualDomains` as today.
- `weldsuite consume` consumes `MAIL_SENDING_EVENTS` (`mail.sending-events`)
  into `weldsuite_mail::consumers::sending_events_batch`.

### Kubernetes and Hetzner

- OpenTofu: a `mail_pools` map (pool → server count, type, locations); each
  mail server gets a primary IPv4 with reverse DNS
  `mail<n>-<pool>.<domain>`; firewall: inbound 25 open, 2587/8025 private
  only (closed on the public side; Hetzner firewalls never filter the
  private network). IPv4 only (no IPv6 on mail nodes). Outputs
  `mail_nodes` and `mail_dns_records`.
- Talos: mail nodes labelled `weldsuite.org/mail-pool=<pool>` (and
  `node.weldsuite.org/pool=mail`) and tainted
  `weldsuite.org/mail=true:NoSchedule`. They also set
  `net.ipv4.ip_unprivileged_port_start=25` in the host network namespace:
  containerd gives a non-root process no ambient capabilities, so the
  chart's `NET_BIND_SERVICE` alone doesn't let `weldsuite mta` (uid 65532)
  bind port 25 on the host network.
- Helm: `mta.enabled`, one DaemonSet per pool (`nodeSelector` on the label,
  `hostNetwork`, `dnsPolicy: ClusterFirstWithHostNet`), one submission
  Service `<release>-mta` (587 → 2587) and one API Service
  `<release>-mta-api` (8025) over all mail pods. The `MTA_*` secrets come
  from `mta.existingSecret` (EU: `weldsuite-mta`, apart from
  `weldsuite-env`); with `mta.wireServer` the server, consume and the cron
  jobs get `MTA_API_URL`, `MTA_API_SECRET`, `SMTP_URL` and `MAIL_SMTP_URL`.
  The bounce MX's certificate is self-signed unless `mta.inbound.tls.issuerRef`
  names a DNS-01 issuer (HTTP-01 can't reach the mail nodes).
- CloudNativePG (EU): database `weldsuite_mta` on the `master` cluster,
  owned by the managed role `mta`; `MTA_DATABASE_URL` points at `master-rw`,
  not the transaction-mode pooler (the MTA's advisory lock is per session).
- Haraka (inbound, unchanged role) is exposed on the EU cluster through the
  ingress load balancer: port 25 → NodePort 30025 (`mx_node_port`), image
  `ghcr.io/weldsuite/weldsuite-haraka` published with the release.
- DNS the operator publishes: A + PTR per mail node; `_spf.<domain>` TXT
  `v=spf1 ip4:<each mail IP> -all`; bounce domain MX → the mail nodes' names
  and SPF `v=spf1 include:_spf.<domain> -all`; the system domain's DKIM
  record (`weldsuite mta domains add`), SPF and DMARC.

## Not in this PR

- IPv6 sending, DANE, a queue admin UI.
