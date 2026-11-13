#!/usr/bin/env node
// Writes WeldSuite's Grafana dashboards (the JSON files next to this script),
// which ../kustomization.yaml turns into ConfigMaps for Grafana's sidecar.
// Edit here, then run it and commit the JSON with it:
//
//   node rust/deploy/flux/infrastructure/monitoring-config/dashboards/generate.mjs
//
// Every query reads the cluster's Prometheus (datasource uid "prometheus").
// Metric names: kube-state-metrics, the node exporter, CloudNativePG, the
// barman-cloud plugin, NATS's exporter, Traefik, the blackbox probes, and the
// weldsuite server (rust/bins/weldsuite/src/monitoring.rs; its job metrics'
// `job` label arrives as `weldsuite_job`, ../monitors.yaml).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ds = { type: 'prometheus', uid: 'prometheus' };

// Filesystems worth watching: not memory, images or Talos's read-only root.
const FS = 'fstype!~"tmpfs|ramfs|squashfs|overlay|nsfs|rootfs"';
// CloudNativePG instances (not poolers, not finished jobs), by cluster.
const PG_PODS = 'namespace=~"postgres|zitadel", pod!~".*-pooler-.*"';
const PG_INSTANCES = `(kube_pod_labels{${PG_PODS}, label_cnpg_io_cluster!=""} unless on (namespace, pod) (kube_pod_status_phase{phase=~"Succeeded|Failed"} == 1))`;
const BACKUP_TS = '(barman_cloud_cloudnative_pg_io_last_available_backup_timestamp or cnpg_collector_last_available_backup_timestamp)';
// Node exporter series carry the pod's address; this adds the node's name.
const NODENAME = '* on (instance) group_left (nodename) node_uname_info';
const asNode = (expr) => `label_replace(${expr}, "node", "$1", "nodename", "(.*)")`;
const RUNNING = '* on (namespace, pod) group_left () (kube_pod_status_phase{phase=~"Pending|Running"} == 1)';
const CRON_FAILED =
  'kube_job_status_failed{namespace="weldsuite"} * on (job_name, namespace) group_left (owner_name) kube_job_owner{namespace="weldsuite", owner_kind="CronJob"}';

// ---- panel helpers --------------------------------------------------------

let nextId = 0;
// A panel's size; layout() fills rows of 24 columns left to right.
function place(w, h) {
  return { w, h, x: 0, y: 0 };
}
function layout(panels) {
  let x = 0;
  let y = 0;
  let rowH = 0;
  for (const p of panels) {
    const g = p.gridPos;
    if (p.type === 'row') {
      if (x !== 0) y += rowH;
      g.x = 0;
      g.y = y;
      y += 1;
      x = 0;
      rowH = 0;
      continue;
    }
    if (x + g.w > 24) {
      y += rowH;
      x = 0;
      rowH = 0;
    }
    g.x = x;
    g.y = y;
    x += g.w;
    rowH = Math.max(rowH, g.h);
  }
  return panels;
}
const targets = (list) =>
  list.map((t, i) => ({ datasource: ds, refId: String.fromCharCode(65 + i), editorMode: 'code', range: !t.instant, ...t }));
function base(type, title, size, list, extra = {}) {
  nextId += 1;
  return { id: nextId, type, title, datasource: ds, gridPos: { ...size }, targets: targets(list), ...extra };
}
const steps = (...s) => ({ mode: 'absolute', steps: [{ color: 'green', value: null }, ...s.map(([value, color]) => ({ value, color }))] });

function row(title) {
  nextId += 1;
  return { id: nextId, type: 'row', title, collapsed: false, gridPos: { w: 24, h: 1, x: 0, y: 0 }, panels: [] };
}
function stat(title, size, list, { unit = 'short', thresholds = steps(), decimals, description, noValue = '0' } = {}) {
  return base('stat', title, size, list.map((t) => ({ instant: true, ...t })), {
    description,
    fieldConfig: { defaults: { unit, decimals, thresholds, color: { mode: 'thresholds' }, noValue }, overrides: [] },
    options: { reduceOptions: { calcs: ['lastNotNull'], fields: '', values: false }, colorMode: 'background', graphMode: 'none', textMode: 'auto', justifyMode: 'center' },
  });
}
function ts(title, size, list, { unit = 'short', thresholds, stack = false, min, max, description, legend = 'table' } = {}) {
  return base('timeseries', title, size, list, {
    description,
    fieldConfig: {
      defaults: {
        unit,
        min,
        max,
        thresholds,
        custom: {
          fillOpacity: stack ? 30 : 8,
          lineWidth: 1,
          stacking: { mode: stack ? 'normal' : 'none' },
          thresholdsStyle: { mode: thresholds ? 'line+area' : 'off' },
          spanNulls: true,
        },
      },
      overrides: [],
    },
    options: {
      legend: { displayMode: legend, placement: legend === 'table' ? 'right' : 'bottom', calcs: legend === 'table' ? ['lastNotNull', 'max'] : [] },
      tooltip: { mode: 'multi', sort: 'desc' },
    },
  });
}
// A table of instant queries merged on their labels: `columns` maps each
// query's value column to a header and unit.
function table(title, size, list, { columns = [], hide = [], sortBy, description } = {}) {
  const exclude = Object.fromEntries(
    ['Time', '__name__', 'job', 'instance', 'endpoint', 'service', 'pod', 'container', 'namespace', 'prometheus', 'cluster', 'uid', ...hide].map((k) => [k, true]),
  );
  const rename = {};
  const overrides = [];
  columns.forEach((c, i) => {
    const field = list.length === 1 ? 'Value' : `Value #${String.fromCharCode(65 + i)}`;
    rename[field] = c.title;
    const props = [];
    if (c.unit) props.push({ id: 'unit', value: c.unit });
    if (c.thresholds) {
      props.push({ id: 'thresholds', value: c.thresholds });
      props.push({ id: 'custom.cellOptions', value: { type: 'color-background', mode: 'basic' } });
    }
    if (c.decimals !== undefined) props.push({ id: 'decimals', value: c.decimals });
    if (props.length) overrides.push({ matcher: { id: 'byName', options: c.title }, properties: props });
  });
  return base('table', title, size, list.map((t) => ({ instant: true, format: 'table', ...t })), {
    description,
    transformations: [
      { id: 'merge', options: {} },
      { id: 'organize', options: { excludeByName: exclude, renameByName: rename } },
    ],
    fieldConfig: { defaults: { custom: { align: 'auto', cellOptions: { type: 'auto' } } }, overrides },
    options: { showHeader: true, sortBy: sortBy ? [sortBy] : [], cellHeight: 'sm' },
  });
}

function dashboard(uid, title, description, panels, templating = []) {
  return {
    uid,
    title,
    description,
    tags: ['weldsuite'],
    timezone: 'browser',
    schemaVersion: 39,
    version: 1,
    editable: false,
    graphTooltip: 1,
    refresh: '1m',
    time: { from: 'now-6h', to: 'now' },
    links: [{ title: 'WeldSuite', type: 'dashboards', tags: ['weldsuite'], asDropdown: true, includeVars: false, keepTime: true }],
    templating: { list: templating },
    panels: layout(panels),
  };
}
function variable(name, label, query) {
  return {
    name,
    label,
    type: 'query',
    datasource: ds,
    query: { query, refId: name },
    definition: query,
    includeAll: true,
    multi: true,
    allValue: '.*',
    current: { text: 'All', value: '$__all' },
    refresh: 2,
    sort: 1,
  };
}
const reset = () => {
  nextId = 0;
};

const dashboards = {};
const S = (w, h = 4) => place(w, h);

// ---- WeldSuite overview -----------------------------------------------------

reset();
dashboards['overview'] = dashboard(
  'weldsuite-overview',
  'WeldSuite overview',
  'Is everything OK? The public hosts, errors, latency, alerts, Postgres, nodes and jobs on one screen.',
  [
    row('Now'),
    stat('Public hosts up', S(4), [{ expr: 'sum(probe_success{group="platform"}) / count(probe_success{group="platform"})' }], {
      unit: 'percentunit',
      thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'orange', value: 0.5 }, { color: 'green', value: 1 }] },
      description: 'app., api., auth. and sign. answering 2xx through the load balancer (blackbox probes).',
    }),
    stat('5xx (5 min)', S(4), [{ expr: '(sum(rate(traefik_service_requests_total{code=~"5.."}[5m])) or vector(0)) / clamp_min(sum(rate(traefik_service_requests_total[5m])), 1e-9)' }], {
      unit: 'percentunit',
      decimals: 2,
      thresholds: steps([0.01, 'orange'], [0.05, 'red']),
      description: 'Share of all requests through Traefik answered with a 5xx.',
    }),
    stat('API p95', S(4), [{ expr: 'histogram_quantile(0.95, sum by (le) (rate(weldsuite_http_request_duration_seconds_bucket{route!~"unmatched|static"}[5m])))' }], {
      unit: 's',
      thresholds: steps([0.5, 'orange'], [1, 'red']),
      noValue: 'no traffic',
    }),
    stat('Critical alerts', S(3), [{ expr: 'count(ALERTS{alertstate="firing", severity="critical"}) or vector(0)' }], { thresholds: steps([1, 'red']) }),
    stat('Warnings', S(3), [{ expr: 'count(ALERTS{alertstate="firing", severity="warning"}) or vector(0)' }], { thresholds: steps([1, 'orange']) }),
    stat('Failed cron runs', S(3), [{ expr: 'count(kube_job_status_failed{namespace="weldsuite"} > 0) or vector(0)' }], {
      thresholds: steps([1, 'orange']),
      description: 'Failed runs of the weldsuite CronJobs still kept by Kubernetes (see "WeldSuite jobs and consumers").',
    }),
    stat('Fullest disk', S(3), [{ expr: `max(1 - node_filesystem_avail_bytes{${FS}} / node_filesystem_size_bytes{${FS}})` }], {
      unit: 'percentunit',
      thresholds: steps([0.8, 'orange'], [0.9, 'red']),
    }),
    stat(
      'Postgres instances ready',
      S(6),
      [
        { expr: `sum((kube_pod_status_ready{${PG_PODS}, condition="true"} == 1) * on (namespace, pod) group_left () ${PG_INSTANCES})`, legendFormat: 'ready' },
        { expr: `count(${PG_INSTANCES})`, legendFormat: 'of' },
      ],
      { description: 'CloudNativePG instances of every cluster (master, tenants, Zitadel\'s). A synchronous replica is required: one down stops writes.' },
    ),
    stat('Oldest last backup', S(6), [{ expr: `time() - min(max by (cnpg_cluster) (${BACKUP_TS}))` }], {
      unit: 'dtdurations',
      thresholds: steps([26 * 3600, 'red']),
      description: 'The cluster whose newest base backup is oldest. Nightly backups: above 26 hours one failed.',
    }),
    stat('Pod restarts (1 h)', S(6), [{ expr: 'sum(increase(kube_pod_container_status_restarts_total[1h])) or vector(0)' }], {
      decimals: 0,
      thresholds: steps([1, 'orange'], [10, 'red']),
    }),
    stat('Nodes ready', S(6), [
      { expr: 'sum(kube_node_status_condition{condition="Ready", status="true"})', legendFormat: 'ready' },
      { expr: 'count(kube_node_info)', legendFormat: 'of' },
    ]),
    table(
      'Firing alerts',
      place(24, 7),
      [{ expr: 'ALERTS{alertstate="firing", alertname!~"Watchdog|InfoInhibitor"}' }],
      { hide: ['alertstate', 'Value'], sortBy: { displayName: 'severity', desc: false }, description: 'What fires now. Meaning and first checks: ALERTS.md in the monitoring-config layer.' },
    ),
    row('Traffic'),
    ts('Requests per service', place(12, 8), [{ expr: 'sum by (service) (rate(traefik_service_requests_total[$__rate_interval]))', legendFormat: '{{service}}' }], {
      unit: 'reqps',
    }),
    ts(
      '5xx share per service',
      place(12, 8),
      [
        {
          expr: 'sum by (service) (rate(traefik_service_requests_total{code=~"5.."}[$__rate_interval])) / clamp_min(sum by (service) (rate(traefik_service_requests_total[$__rate_interval])), 1e-9)',
          legendFormat: '{{service}}',
        },
      ],
      { unit: 'percentunit', thresholds: steps([0.05, 'red']) },
    ),
    ts('Public hosts (probe success)', place(12, 7), [{ expr: 'probe_success', legendFormat: '{{instance}}' }], { unit: 'percentunit', min: 0, max: 1 }),
    ts('Probe duration', place(12, 7), [{ expr: 'probe_duration_seconds', legendFormat: '{{instance}}' }], { unit: 's' }),
    row('Nodes'),
    ts('CPU used', place(8, 8), [{ expr: `(1 - avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval]))) ${NODENAME}`, legendFormat: '{{nodename}}' }], {
      unit: 'percentunit',
      min: 0,
      max: 1,
      legend: 'list',
    }),
    ts('Memory used', place(8, 8), [{ expr: `(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) ${NODENAME}`, legendFormat: '{{nodename}}' }], {
      unit: 'percentunit',
      min: 0,
      max: 1,
      legend: 'list',
    }),
    ts(
      'Disk used',
      place(8, 8),
      [{ expr: `max by (instance, device) (1 - node_filesystem_avail_bytes{${FS}} / node_filesystem_size_bytes{${FS}}) ${NODENAME}`, legendFormat: '{{nodename}} {{device}}' }],
      { unit: 'percentunit', min: 0, max: 1, thresholds: steps([0.8, 'orange'], [0.9, 'red']), legend: 'list' },
    ),
    ts('Restarts per namespace (1 h)', place(12, 7), [{ expr: 'sum by (namespace) (increase(kube_pod_container_status_restarts_total[1h])) > 0', legendFormat: '{{namespace}}' }], {
      decimals: 0,
    }),
    ts('Pods not ready per namespace', place(12, 7), [{ expr: 'sum by (namespace) (kube_pod_status_ready{condition="false"} * on (namespace, pod) group_left () (kube_pod_status_phase{phase=~"Pending|Running"} == 1)) > 0', legendFormat: '{{namespace}}' }], {
      decimals: 0,
    }),
  ],
);

// ---- WeldSuite jobs and consumers -------------------------------------------

reset();
dashboards['jobs'] = dashboard(
  'weldsuite-jobs',
  'WeldSuite jobs and consumers',
  'The weldsuite CronJobs, the server\'s durable jobs, the event consumers on NATS JetStream, and the MTA.',
  [
    row('Cron jobs'),
    table(
      'CronJobs (weldsuite)',
      place(24, 11),
      [
        { expr: 'max by (cronjob) (time() - kube_cronjob_status_last_successful_time{namespace="weldsuite"})' },
        { expr: 'max by (cronjob) (time() - kube_cronjob_status_last_schedule_time{namespace="weldsuite"})' },
        { expr: 'max by (cronjob) (kube_cronjob_status_active{namespace="weldsuite"})' },
        { expr: 'max by (cronjob) (kube_cronjob_spec_suspend{namespace="weldsuite"})' },
        { expr: `sum by (cronjob) (label_replace(${CRON_FAILED}, "cronjob", "$1", "owner_name", "(.*)")) or max by (cronjob) (kube_cronjob_info{namespace="weldsuite"} * 0)` },
      ],
      {
        columns: [
          { title: 'Last success', unit: 'dtdurations' },
          { title: 'Last run', unit: 'dtdurations' },
          { title: 'Running', decimals: 0 },
          { title: 'Suspended', decimals: 0 },
          { title: 'Failed runs kept', decimals: 0, thresholds: steps([1, 'red']) },
        ],
        sortBy: { displayName: 'Failed runs kept', desc: true },
        description: 'Times are how long ago. Failed runs kept: failed Jobs Kubernetes still holds (failedJobsHistoryLimit); their pods\' logs say why.',
      },
    ),
    ts('Failed runs per CronJob', place(12, 7), [{ expr: `sum by (owner_name) (${CRON_FAILED}) > 0`, legendFormat: '{{owner_name}}' }], { decimals: 0 }),
    ts('Running jobs', place(12, 7), [{ expr: 'sum by (cronjob) (kube_cronjob_status_active{namespace="weldsuite"}) > 0', legendFormat: '{{cronjob}}' }], {
      decimals: 0,
      stack: true,
    }),
    row('Durable jobs (the server)'),
    ts('Runs per job', place(8, 8), [{ expr: 'sum by (weldsuite_job, outcome) (rate(weldsuite_job_runs_total[$__rate_interval]))', legendFormat: '{{weldsuite_job}} {{outcome}}' }], {
      unit: 'ops',
    }),
    ts(
      'Failed share per job',
      place(8, 8),
      [
        {
          expr: 'sum by (weldsuite_job) (rate(weldsuite_job_runs_total{outcome="error"}[$__rate_interval])) / clamp_min(sum by (weldsuite_job) (rate(weldsuite_job_runs_total[$__rate_interval])), 1e-9)',
          legendFormat: '{{weldsuite_job}}',
        },
      ],
      { unit: 'percentunit', thresholds: steps([0.1, 'red']) },
    ),
    ts('p95 duration per job', place(8, 8), [{ expr: 'histogram_quantile(0.95, sum by (le, weldsuite_job) (rate(weldsuite_job_duration_seconds_bucket[$__rate_interval])))', legendFormat: '{{weldsuite_job}}' }], {
      unit: 's',
    }),
    row('Event consumers (weldsuite consume on NATS JetStream)'),
    ts('Messages per consumer', place(12, 8), [{ expr: 'sum by (consumer, outcome) (rate(weldsuite_consumer_messages_total[$__rate_interval]))', legendFormat: '{{consumer}} {{outcome}}' }], {
      unit: 'ops',
    }),
    ts(
      'Errors and redeliveries per consumer',
      place(12, 8),
      [{ expr: 'sum by (consumer, outcome) (rate(weldsuite_consumer_messages_total{outcome=~"error|redelivered"}[$__rate_interval])) > 0', legendFormat: '{{consumer}} {{outcome}}' }],
      { unit: 'ops', description: 'redelivered: NAKed for a retry or a deferral. error: dead-lettered.' },
    ),
    ts('Pending per consumer', place(8, 8), [{ expr: 'max by (consumer_name) (nats_consumer_num_pending)', legendFormat: '{{consumer_name}}' }], {
      decimals: 0,
      description: 'Messages not yet delivered: grows when consume falls behind (alert ConsumerLagGrowing).',
    }),
    ts('Awaiting ack per consumer', place(8, 8), [{ expr: 'max by (consumer_name) (nats_consumer_num_ack_pending)', legendFormat: '{{consumer_name}}' }], { decimals: 0 }),
    ts('Redelivered per consumer (total)', place(8, 8), [{ expr: 'max by (consumer_name) (nats_consumer_num_redelivered)', legendFormat: '{{consumer_name}}' }], { decimals: 0 }),
    ts('Messages per stream', place(8, 7), [{ expr: 'max by (stream_name) (nats_stream_total_messages)', legendFormat: '{{stream_name}}' }], { decimals: 0 }),
    ts('Bytes per stream', place(8, 7), [{ expr: 'max by (stream_name) (nats_stream_total_bytes)', legendFormat: '{{stream_name}}' }], { unit: 'bytes' }),
    ts(
      'JetStream storage',
      place(8, 7),
      [
        { expr: 'max(nats_varz_jetstream_stats_storage)', legendFormat: 'used' },
        { expr: 'max(nats_varz_jetstream_config_max_storage)', legendFormat: 'limit' },
      ],
      { unit: 'bytes', legend: 'list' },
    ),
    row('Mail (the MTA)'),
    ts('Messages per pool and outcome', place(24, 7), [{ expr: 'sum by (pool, outcome) (rate(weldsuite_mta_messages_total[$__rate_interval]))', legendFormat: '{{pool}} {{outcome}}' }], {
      unit: 'ops',
      description: 'delivered, deferred (a retry later) and bounced (refused, or out of retries).',
    }),
  ],
);

// ---- WeldSuite Postgres and backups -----------------------------------------

reset();
const C = '{cnpg_cluster=~"$cnpg_cluster"}';
const c = 'cnpg_cluster=~"$cnpg_cluster"';
dashboards['postgres'] = dashboard(
  'weldsuite-postgres',
  'WeldSuite Postgres and backups',
  'The CloudNativePG clusters as the alerts see them: instances, backups, WAL archiving, connections, replication, size. Detail: the CloudNativePG dashboard (Components).',
  [
    row('Clusters'),
    table(
      'Clusters now',
      place(24, 6),
      [
        {
          expr: `sum by (cnpg_cluster) (label_replace((kube_pod_status_ready{${PG_PODS}, condition="true"} == 1) * on (namespace, pod) group_left (label_cnpg_io_cluster) ${PG_INSTANCES}, "cnpg_cluster", "$1", "label_cnpg_io_cluster", "(.*)"))`,
        },
        { expr: `count by (cnpg_cluster) (label_replace(${PG_INSTANCES}, "cnpg_cluster", "$1", "label_cnpg_io_cluster", "(.*)"))` },
        { expr: `time() - max by (cnpg_cluster) (${BACKUP_TS})` },
        { expr: 'min by (cnpg_cluster) (cnpg_pg_stat_archiver_seconds_since_last_archival and on (namespace, pod) (cnpg_pg_replication_in_recovery == 0))' },
        { expr: 'max by (cnpg_cluster) (cnpg_pg_stat_archiver_last_failed_time > bool cnpg_pg_stat_archiver_last_archived_time)' },
        { expr: 'max by (cnpg_cluster) (sum by (cnpg_cluster, pod) (cnpg_backends_total) / on (cnpg_cluster, pod) max by (cnpg_cluster, pod) (cnpg_pg_settings_setting{name="max_connections"}))' },
        { expr: 'sum by (cnpg_cluster) (max by (cnpg_cluster, datname) (cnpg_pg_database_size_bytes{datname!~"template.*|postgres"}))' },
      ],
      {
        columns: [
          { title: 'Ready', decimals: 0 },
          { title: 'Instances', decimals: 0 },
          { title: 'Last backup', unit: 'dtdurations', thresholds: steps([26 * 3600, 'red']) },
          { title: 'Last WAL archived', unit: 'dtdurations', thresholds: steps([3600, 'orange']) },
          { title: 'Archiving failing', decimals: 0, thresholds: steps([1, 'red']) },
          { title: 'Connections used', unit: 'percentunit', thresholds: steps([0.8, 'orange'], [0.95, 'red']) },
          { title: 'Size', unit: 'bytes' },
        ],
        description: 'Last backup: age of the newest base backup (nightly). Last WAL archived: on the primary, with any writes at least every 5 minutes.',
      },
    ),
    ts(
      'Age of the newest base backup',
      place(12, 8),
      [
        {
          expr: `time() - max by (cnpg_cluster) (barman_cloud_cloudnative_pg_io_last_available_backup_timestamp${C} or cnpg_collector_last_available_backup_timestamp${C})`,
          legendFormat: '{{cnpg_cluster}}',
        },
      ],
      {
      unit: 'dtdurations',
      thresholds: steps([26 * 3600, 'red']),
    }),
    ts('Since the last WAL archived (primary)', place(12, 8), [
      { expr: `cnpg_pg_stat_archiver_seconds_since_last_archival${C} and on (namespace, pod) (cnpg_pg_replication_in_recovery == 0)`, legendFormat: '{{cnpg_cluster}}' },
    ], { unit: 's', thresholds: steps([3600, 'orange']) }),
    row('Load'),
    ts(
      'Connections per instance',
      place(12, 8),
      [
        { expr: `sum by (pod) (cnpg_backends_total${C})`, legendFormat: '{{pod}}' },
        { expr: `max by (cnpg_cluster) (cnpg_pg_settings_setting{name="max_connections", ${c}})`, legendFormat: 'max_connections {{cnpg_cluster}}' },
      ],
      { decimals: 0 },
    ),
    ts(
      'Server connection pools (weldsuite)',
      place(12, 8),
      [
        { expr: 'sum by (pool) (weldsuite_db_pool_connections{state="in_use"})', legendFormat: '{{pool}} in use' },
        { expr: 'sum by (pool) (weldsuite_db_pool_connections{state="idle"})', legendFormat: '{{pool}} idle' },
        { expr: 'sum by (pool) (weldsuite_db_pool_max_connections)', legendFormat: '{{pool}} max' },
      ],
      { decimals: 0, description: 'The pools of every server, consume and MTA pod together. tenant: every workspace\'s pool summed.' },
    ),
    ts('Transactions', place(8, 8), [
      { expr: `sum by (cnpg_cluster) (rate(cnpg_pg_stat_database_xact_commit${C}[$__rate_interval]))`, legendFormat: '{{cnpg_cluster}} commit' },
      { expr: `sum by (cnpg_cluster) (rate(cnpg_pg_stat_database_xact_rollback${C}[$__rate_interval]))`, legendFormat: '{{cnpg_cluster}} rollback' },
    ], { unit: 'ops' }),
    ts(
      'Cache hit ratio',
      place(8, 8),
      [
        {
          expr: `sum by (cnpg_cluster) (rate(cnpg_pg_stat_database_blks_hit${C}[$__rate_interval])) / clamp_min(sum by (cnpg_cluster) (rate(cnpg_pg_stat_database_blks_hit${C}[$__rate_interval])) + sum by (cnpg_cluster) (rate(cnpg_pg_stat_database_blks_read${C}[$__rate_interval])), 1e-9)`,
          legendFormat: '{{cnpg_cluster}}',
        },
      ],
      { unit: 'percentunit', max: 1, description: 'Below about 99% the working set no longer fits shared_buffers.' },
    ),
    ts('WAL written', place(8, 8), [{ expr: `sum by (cnpg_cluster) (rate(cnpg_collector_wal_bytes${C}[$__rate_interval]))`, legendFormat: '{{cnpg_cluster}}' }], {
      unit: 'Bps',
    }),
    row('Replication and size'),
    ts('Replication lag', place(8, 8), [{ expr: `max by (pod) (cnpg_pg_replication_lag${C})`, legendFormat: '{{pod}}' }], {
      unit: 's',
      thresholds: steps([60, 'orange']),
    }),
    ts('Database size', place(8, 8), [{ expr: `max by (cnpg_cluster, datname) (cnpg_pg_database_size_bytes{${c}, datname!~"template.*|postgres"})`, legendFormat: '{{cnpg_cluster}} {{datname}}' }], {
      unit: 'bytes',
    }),
    ts('Transaction ID age (wraparound)', place(8, 8), [{ expr: `max by (cnpg_cluster) (cnpg_pg_database_xid_age${C})`, legendFormat: '{{cnpg_cluster}}' }], {
      decimals: 0,
      thresholds: steps([1e9, 'orange'], [1.5e9, 'red']),
      description: 'Autovacuum keeps this far below 2 billion; a steady climb means vacuum can\'t keep up.',
    }),
    ts('Deadlocks', place(12, 7), [{ expr: `sum by (cnpg_cluster) (increase(cnpg_pg_stat_database_deadlocks${C}[$__rate_interval])) > 0`, legendFormat: '{{cnpg_cluster}}' }], { decimals: 0 }),
    ts('Temporary files written', place(12, 7), [{ expr: `sum by (cnpg_cluster) (rate(cnpg_pg_stat_database_temp_bytes${C}[$__rate_interval]))`, legendFormat: '{{cnpg_cluster}}' }], {
      unit: 'Bps',
      description: 'Sorts and hashes that didn\'t fit work_mem.',
    }),
  ],
  [variable('cnpg_cluster', 'Cluster', 'label_values(cnpg_collector_up, cnpg_cluster)')],
);

// ---- WeldSuite capacity -----------------------------------------------------

reset();
const reqBy = (resource) => `sum by (node) (kube_pod_container_resource_requests{resource="${resource}"} ${RUNNING})`;
const allocBy = (resource) => `sum by (node) (kube_node_status_allocatable{resource="${resource}"})`;
dashboards['capacity'] = dashboard(
  'weldsuite-capacity',
  'WeldSuite capacity',
  'Room left per node: what the pods ask for (requests) and use, against what each node has. For deciding when another node is due.',
  [
    row('Headroom now'),
    stat('Memory free to request (emptiest node)', S(6), [{ expr: `max(${allocBy('memory')} - ${reqBy('memory')})` }], {
      unit: 'bytes',
      thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'orange', value: 512 * 1024 ** 2 }, { color: 'green', value: 2 * 1024 ** 3 }] },
      description: 'The largest pod that still fits anywhere, by memory request.',
    }),
    stat('CPU free to request (emptiest node)', S(6), [{ expr: `max(${allocBy('cpu')} - ${reqBy('cpu')})` }], {
      decimals: 2,
      thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'orange', value: 0.25 }, { color: 'green', value: 1 }] },
      description: 'Cores, the largest CPU request that still fits.',
    }),
    stat('Memory requested (cluster)', S(6), [{ expr: `sum(${reqBy('memory')}) / sum(${allocBy('memory')})` }], {
      unit: 'percentunit',
      thresholds: steps([0.75, 'orange'], [0.9, 'red']),
    }),
    stat('Memory used (cluster)', S(6), [{ expr: 'sum(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) / sum(node_memory_MemTotal_bytes)' }], {
      unit: 'percentunit',
      thresholds: steps([0.75, 'orange'], [0.9, 'red']),
    }),
    table(
      'Per node',
      place(24, 9),
      [
        { expr: allocBy('cpu') },
        { expr: reqBy('cpu') },
        { expr: `sum by (node) (${asNode(`sum by (instance) (rate(node_cpu_seconds_total{mode!="idle"}[5m])) ${NODENAME}`)})` },
        { expr: allocBy('memory') },
        { expr: reqBy('memory') },
        { expr: `sum by (node) (${asNode(`(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes) ${NODENAME}`)})` },
        { expr: `count by (node) (kube_pod_info{node!=""} ${RUNNING})` },
        { expr: allocBy('pods') },
        { expr: `max by (node) (${asNode(`max by (instance, device) (1 - node_filesystem_avail_bytes{${FS}} / node_filesystem_size_bytes{${FS}}) ${NODENAME}`)})` },
      ],
      {
        columns: [
          { title: 'CPU', decimals: 2 },
          { title: 'CPU requested', decimals: 2 },
          { title: 'CPU used', decimals: 2 },
          { title: 'Memory', unit: 'bytes' },
          { title: 'Memory requested', unit: 'bytes' },
          { title: 'Memory used', unit: 'bytes' },
          { title: 'Pods', decimals: 0 },
          { title: 'Pod limit', decimals: 0 },
          { title: 'Disk used', unit: 'percentunit', thresholds: steps([0.8, 'orange'], [0.9, 'red']) },
        ],
        hide: ['nodename'],
        sortBy: { displayName: 'node', desc: false },
        description: 'CPU in cores. Requested: what the scheduler has promised the running pods; a node full of requests takes no more pods, however idle.',
      },
    ),
    row('Over time'),
    ts('Memory requested per node', place(12, 8), [{ expr: `${reqBy('memory')} / ${allocBy('memory')}`, legendFormat: '{{node}}' }], {
      unit: 'percentunit',
      min: 0,
      max: 1,
      thresholds: steps([0.9, 'red']),
    }),
    ts('CPU requested per node', place(12, 8), [{ expr: `${reqBy('cpu')} / ${allocBy('cpu')}`, legendFormat: '{{node}}' }], {
      unit: 'percentunit',
      min: 0,
      max: 1,
      thresholds: steps([0.9, 'red']),
    }),
    ts(
      'Cluster memory',
      place(12, 8),
      [
        { expr: `sum(${allocBy('memory')})`, legendFormat: 'allocatable' },
        { expr: `sum(${reqBy('memory')})`, legendFormat: 'requested' },
        { expr: 'sum(node_memory_MemTotal_bytes - node_memory_MemAvailable_bytes)', legendFormat: 'used' },
      ],
      { unit: 'bytes', legend: 'list' },
    ),
    ts(
      'Cluster CPU',
      place(12, 8),
      [
        { expr: `sum(${allocBy('cpu')})`, legendFormat: 'allocatable' },
        { expr: `sum(${reqBy('cpu')})`, legendFormat: 'requested' },
        { expr: 'sum(rate(node_cpu_seconds_total{mode!="idle"}[$__rate_interval]))', legendFormat: 'used' },
      ],
      { decimals: 2, legend: 'list' },
    ),
    ts('Memory used per namespace', place(12, 9), [{ expr: 'sum by (namespace) (container_memory_working_set_bytes{container!="", image!=""})', legendFormat: '{{namespace}}' }], {
      unit: 'bytes',
      stack: true,
    }),
    ts('CPU used per namespace', place(12, 9), [{ expr: 'sum by (namespace) (rate(container_cpu_usage_seconds_total{container!="", image!=""}[$__rate_interval]))', legendFormat: '{{namespace}}' }], {
      decimals: 2,
      stack: true,
    }),
    ts(
      'Disk used per node',
      place(24, 7),
      [{ expr: `max by (instance, device) (1 - node_filesystem_avail_bytes{${FS}} / node_filesystem_size_bytes{${FS}}) ${NODENAME}`, legendFormat: '{{nodename}} {{device}}' }],
      { unit: 'percentunit', min: 0, max: 1, thresholds: steps([0.8, 'orange'], [0.9, 'red']), legend: 'list' },
    ),
  ],
);

// ---- WeldSuite API (the server's own metrics) ---------------------------------

reset();
const routeVar = variable('route', 'Route', 'label_values(weldsuite_http_requests_total, route)');
dashboards['weldsuite-api'] = dashboard(
  'weldsuite-api',
  'WeldSuite API',
  'The weldsuite server: requests, errors and latency per route, its database pools and consumers.',
  [
    stat('Requests / s', S(6), [{ expr: 'sum(rate(weldsuite_http_requests_total[5m]))' }], { unit: 'reqps' }),
    stat('5xx share', S(6), [{ expr: '(sum(rate(weldsuite_http_requests_total{status=~"5.."}[5m])) or vector(0)) / clamp_min(sum(rate(weldsuite_http_requests_total[5m])), 1e-9)' }], {
      unit: 'percentunit',
      decimals: 2,
      thresholds: steps([0.01, 'orange'], [0.05, 'red']),
    }),
    stat('p95 latency', S(6), [{ expr: 'histogram_quantile(0.95, sum by (le) (rate(weldsuite_http_request_duration_seconds_bucket{route!~"unmatched|static"}[5m])))' }], {
      unit: 's',
      thresholds: steps([0.5, 'orange'], [1, 'red']),
      noValue: 'no traffic',
    }),
    stat('In flight', S(6), [{ expr: 'sum(weldsuite_http_requests_in_flight)' }]),
    ts('Requests by status', place(12, 8), [{ expr: 'sum by (status) (rate(weldsuite_http_requests_total{route=~"$route"}[$__rate_interval]))', legendFormat: '{{status}}' }], {
      unit: 'reqps',
    }),
    ts('5xx by route', place(12, 8), [{ expr: 'topk(10, sum by (route) (rate(weldsuite_http_requests_total{status=~"5..", route=~"$route"}[$__rate_interval])))', legendFormat: '{{route}}' }], {
      unit: 'reqps',
    }),
    ts(
      'p95 latency by route (top 10)',
      place(12, 8),
      [{ expr: 'topk(10, histogram_quantile(0.95, sum by (le, route) (rate(weldsuite_http_request_duration_seconds_bucket{route=~"$route", route!~"unmatched|static"}[$__rate_interval]))))', legendFormat: '{{route}}' }],
      { unit: 's' },
    ),
    ts('Busiest routes', place(12, 8), [{ expr: 'topk(10, sum by (route) (rate(weldsuite_http_requests_total{route=~"$route"}[$__rate_interval])))', legendFormat: '{{route}}' }], {
      unit: 'reqps',
    }),
    ts(
      'Database pools in use',
      place(12, 8),
      [
        { expr: 'sum by (pod, pool) (weldsuite_db_pool_connections{state="in_use"})', legendFormat: '{{pod}} {{pool}} in use' },
        { expr: 'max by (pool) (weldsuite_db_pool_max_connections)', legendFormat: '{{pool}} max' },
      ],
      { decimals: 0 },
    ),
    ts('Consumers', place(12, 8), [{ expr: 'sum by (consumer, outcome) (rate(weldsuite_consumer_messages_total[$__rate_interval]))', legendFormat: '{{consumer}} {{outcome}}' }], {
      unit: 'ops',
    }),
    ts('Pod restarts (weldsuite)', place(24, 7), [{ expr: 'sum by (pod) (increase(kube_pod_container_status_restarts_total{namespace="weldsuite"}[1h])) > 0', legendFormat: '{{pod}}' }], {
      decimals: 0,
    }),
  ],
  [routeVar],
);

// ---- WeldSuite public endpoints -------------------------------------------------

reset();
dashboards['public-endpoints'] = dashboard(
  'weldsuite-public-endpoints',
  'WeldSuite public endpoints',
  'The blackbox probes of the public hosts, and Traefik\'s view of the services behind them.',
  [
    table(
      'Probes now',
      place(24, 7),
      [{ expr: 'probe_success' }, { expr: 'probe_http_status_code' }, { expr: '(probe_ssl_earliest_cert_expiry - time()) / 86400' }],
      {
        columns: [
          { title: 'Up', decimals: 0, thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'green', value: 1 }] } },
          { title: 'HTTP status', decimals: 0 },
          { title: 'Certificate days left', decimals: 0, thresholds: { mode: 'absolute', steps: [{ color: 'red', value: null }, { color: 'orange', value: 7 }, { color: 'green', value: 21 }] } },
        ],
      },
    ),
    ts('Probe duration', place(12, 8), [{ expr: 'probe_duration_seconds', legendFormat: '{{instance}}' }], { unit: 's' }),
    ts('Probe success (5 min average)', place(12, 8), [{ expr: 'avg_over_time(probe_success[5m])', legendFormat: '{{instance}}' }], { unit: 'percentunit', min: 0, max: 1 }),
    ts('Requests per service (Traefik)', place(12, 8), [{ expr: 'sum by (service) (rate(traefik_service_requests_total[$__rate_interval]))', legendFormat: '{{service}}' }], {
      unit: 'reqps',
    }),
    ts(
      '5xx share per service (Traefik)',
      place(12, 8),
      [
        {
          expr: 'sum by (service) (rate(traefik_service_requests_total{code=~"5.."}[$__rate_interval])) / clamp_min(sum by (service) (rate(traefik_service_requests_total[$__rate_interval])), 1e-9)',
          legendFormat: '{{service}}',
        },
      ],
      { unit: 'percentunit' },
    ),
  ],
);

for (const [name, dash] of Object.entries(dashboards)) {
  writeFileSync(join(here, `${name}.json`), `${JSON.stringify(dash, null, 2)}\n`);
  const count = dash.panels.filter((p) => p.type !== 'row').length;
  console.log(`${name}.json: ${dash.title}, ${count} panels`);
}
