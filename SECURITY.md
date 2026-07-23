# Security Policy

We take the security of WeldSuite seriously. Because this is a source-visible business platform that handles customer data, we ask that you report vulnerabilities responsibly.

## Reporting a vulnerability

**Please do not report security issues through public GitHub issues, pull requests, or discussions.**

Instead, use one of these private channels:

1. **GitHub private vulnerability reporting** (preferred): go to the **Security** tab of this repository and click **Report a vulnerability**. This opens a private advisory visible only to you and the maintainers.
2. **Email:** send details to **security@weldsuite.org**. If you'd like to encrypt your report, ask for a PGP key first.

Please include, as far as you can:

- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept, affected endpoints, request/response samples)
- The affected component (e.g. `app-api`, a specific worker, the platform SPA)
- Any suggested remediation

## What to expect

- **Acknowledgement** within **3 business days**.
- An initial assessment and severity rating within **10 business days**.
- Regular updates as we work on a fix.
- Credit in the release notes / advisory once the issue is resolved, if you'd like it.

## Scope

In scope: the code in this repository, the platform SPA, the Cloudflare Workers (especially `app-api`, `external-api`, `realtime-worker`, `mcp-server`, the widget API), the shared packages, and the mobile apps.

Out of scope: the hosted infrastructure and any third-party services (Cloudflare, Neon, Clerk, Stripe, etc.). Report those to the respective vendors. Denial-of-service testing, social engineering, and physical attacks are not authorized.

## Safe harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to follow this policy,
- Avoid privacy violations, data destruction, and service disruption,
- Only interact with accounts they own or have explicit permission to test, and
- Give us reasonable time to remediate before any public disclosure.

Thank you for helping keep WeldSuite and its users safe.
