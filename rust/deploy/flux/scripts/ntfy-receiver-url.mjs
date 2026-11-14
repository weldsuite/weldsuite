#!/usr/bin/env node
// Prints an Alertmanager receiver URL for an ntfy topic: ntfy's message
// template (ntfy 2.10+, `tpl=1`) turns Alertmanager's webhook JSON into a
// title and a body, at a fixed priority. The value goes into the cluster's
// Secret monitoring/alerting-receivers (critical-url or warning-url); the
// topic's access token goes into its `token` key, which Alertmanager sends as
// a bearer token (infrastructure/monitoring-config/ALERTS.md, "Receivers").
//
//   node rust/deploy/flux/scripts/ntfy-receiver-url.mjs <topic URL> <priority 1-5> [grafana URL]
//
//   node rust/deploy/flux/scripts/ntfy-receiver-url.mjs https://ntfy.sh/my-critical 5 https://grafana.example.com
//
// fill-secrets.mjs reads it from ALERT_CRITICAL_URL / ALERT_WARNING_URL:
//
//   ALERT_CRITICAL_URL="$(node rust/deploy/flux/scripts/ntfy-receiver-url.mjs https://ntfy.sh/my-critical 5)"
const [topic, priority, grafana] = process.argv.slice(2);
if (!topic || !/^https?:\/\/[^/]+\/[^/?#]+$/.test(topic) || !/^[1-5]$/.test(priority ?? '')) {
  console.error('usage: node ntfy-receiver-url.mjs <https://server/topic> <priority 1-5> [grafana URL]');
  process.exit(2);
}

// Alertmanager's webhook body: status, commonLabels (cluster, alertname,
// severity, …) and alerts[] with labels and annotations. Flux's alerts carry
// a message instead of a summary.
const title = '{{.commonLabels.cluster}}: {{.commonLabels.alertname}}{{if eq .status "resolved"}} (resolved){{end}}';
const message =
  '{{range .alerts}}{{if .annotations.summary}}{{.annotations.summary}}{{else}}{{.annotations.message}}{{end}}\n{{end}}';
const tags = { 5: 'rotating_light', 4: 'warning', 3: 'warning' }[priority] ?? 'information_source';

const params = new URLSearchParams({ tpl: '1', p: priority, ta: tags, t: title, m: message });
if (grafana) params.set('click', grafana);
console.log(`${topic}?${params.toString()}`);
