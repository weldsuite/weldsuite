{{- define "weldsuite.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "weldsuite.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "weldsuite.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "weldsuite.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: weldsuite
{{- end }}

{{- define "weldsuite.selectorLabels" -}}
app.kubernetes.io/name: {{ include "weldsuite.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: api
{{- end }}

{{- define "weldsuite.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "weldsuite.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "weldsuite.secretName" -}}
{{- default (include "weldsuite.fullname" .) .Values.secret.existingSecret }}
{{- end }}

{{- define "weldsuite.jwksConfigMap" -}}
{{- default (printf "%s-clerk-jwks" (include "weldsuite.fullname" .)) .Values.clerkJwks.existingConfigMap }}
{{- end }}

{{/*
The environment of every container that runs the binary: the server, the
cron jobs and the migration Job read the same settings
(rust/bins/weldsuite/src/config.rs).
*/}}
{{- define "weldsuite.env" -}}
- name: PORT
  value: "8080"
- name: ENVIRONMENT
  value: {{ .Values.config.environment | quote }}
- name: LOG_FORMAT
  value: {{ .Values.config.logFormat | quote }}
- name: RUST_LOG
  value: {{ .Values.config.logLevel | quote }}
- name: PERMISSIONS_APP_ENFORCE
  value: {{ .Values.config.permissionsAppEnforce | toString | quote }}
{{- with .Values.config.auth }}
- name: AUTH_PROVIDER
  value: {{ .provider | quote }}
{{- if eq .provider "oidc" }}
- name: OIDC_ISSUER
  value: {{ required "config.auth.oidc.issuer is required with config.auth.provider oidc" .oidc.issuer | quote }}
- name: OIDC_AUDIENCE
  value: {{ required "config.auth.oidc.audience is required with config.auth.provider oidc" .oidc.audience | toString | quote }}
- name: OIDC_ORG_CLAIM
  value: {{ .oidc.orgClaim | quote }}
{{- with .oidc.jwksUrl }}
- name: OIDC_JWKS_URL
  value: {{ . | quote }}
{{- end }}
{{- with .oidc.webClientId }}
- name: OIDC_WEB_CLIENT_ID
  value: {{ . | toString | quote }}
{{- end }}
{{- else if ne .provider "clerk" }}
{{- fail "config.auth.provider must be clerk or oidc" }}
{{- end }}
{{- end }}
{{- with .Values.config.clerkAuthorizedParties }}
- name: CLERK_AUTHORIZED_PARTIES
  value: {{ . | quote }}
{{- end }}
- name: DATABASE_MASTER_MAX_CONNECTIONS
  value: {{ .Values.config.masterMaxConnections | quote }}
- name: TENANT_POOL_MAX_CONNECTIONS
  value: {{ .Values.config.tenantPoolMaxConnections | quote }}
- name: TENANT_POOLS_MAX
  value: {{ .Values.config.tenantPoolsMax | quote }}
- name: WORKSPACE_CACHE_TTL_SECONDS
  value: {{ .Values.config.workspaceCacheTtlSeconds | quote }}
- name: SHUTDOWN_DELAY_SECONDS
  value: {{ .Values.config.shutdownDelaySeconds | quote }}
- name: FEATURE_FLAGS
  value: {{ .Values.config.featureFlags | quote }}
- name: FEATURE_FLAGS_REFRESH_SECONDS
  value: {{ .Values.config.featureFlagsRefreshSeconds | quote }}
- name: VALKEY_CACHE_PREFIX
  value: {{ .Values.config.valkey.cachePrefix | quote }}
- name: VALKEY_REALTIME_PREFIX
  value: {{ .Values.config.valkey.realtimePrefix | quote }}
- name: NATS_ENTITY_EVENTS_STREAM
  value: {{ .Values.config.nats.entityEventsStream | quote }}
- name: NATS_ENTITY_EVENTS_SUBJECT
  value: {{ .Values.config.nats.entityEventsSubject | quote }}
- name: NATS_ENSURE_STREAMS
  value: {{ .Values.config.nats.ensureStreams | toString | quote }}
{{- with .Values.config.files }}
{{- if .endpoint }}
- name: S3_ENDPOINT
  value: {{ .endpoint | quote }}
- name: S3_REGION
  value: {{ .region | quote }}
- name: S3_BUCKET_PRIVATE
  value: {{ required "config.files.privateBucket is required with config.files.endpoint" .privateBucket | quote }}
{{- if .publicBucket }}
- name: S3_BUCKET_PUBLIC
  value: {{ .publicBucket | quote }}
{{- end }}
- name: S3_FORCE_PATH_STYLE
  value: {{ .forcePathStyle | toString | quote }}
{{- end }}
{{- end }}
{{- with .Values.config.jobs }}
{{- if .restate.ingressUrl }}
- name: RESTATE_INGRESS_URL
  value: {{ .restate.ingressUrl | quote }}
- name: JOBS_PORT
  value: {{ .port | quote }}
{{- if .restate.adminUrl }}
- name: RESTATE_ADMIN_URL
  value: {{ .restate.adminUrl | quote }}
- name: RESTATE_DEPLOYMENT_URI
  value: {{ printf "http://%s-jobs.%s.svc:%v" (include "weldsuite.fullname" $) $.Release.Namespace .port | quote }}
{{- end }}
{{- end }}
{{- end }}
{{- with .Values.config.mail.from }}
- name: SYSTEM_EMAIL_FROM
  value: {{ . | quote }}
{{- end }}
{{- if .Values.clerkJwks.enabled }}
- name: CLERK_JWKS_FILE
  value: /etc/weldsuite/clerk/jwks.json
{{- end }}
{{- with .Values.config.sign.portalUrl }}
- name: SIGN_PORTAL_URL
  value: {{ . | quote }}
{{- end }}
{{- with .Values.config.identity.zitadel }}
{{- if .apiUrl }}
- name: ZITADEL_API_URL
  value: {{ .apiUrl | quote }}
- name: ZITADEL_PROJECT_ID
  value: {{ required "config.identity.zitadel.projectId is required with config.identity.zitadel.apiUrl" .projectId | toString | quote }}
{{- with .host }}
- name: ZITADEL_HOST
  value: {{ . | quote }}
{{- end }}
{{- with .inviteUrlTemplate }}
- name: ZITADEL_INVITE_URL_TEMPLATE
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- end }}
{{- with .Values.config.tenants.region }}
- name: TENANT_REGION
  value: {{ . | quote }}
{{- end }}
- name: FIELD_ENCRYPTION_AAD_WRITES
  value: {{ .Values.config.aadWrites | toString | quote }}
{{- with .Values.config.extraEnv }}
{{- toYaml . | nindent 0 }}
{{- end }}
{{- end }}

{{- define "weldsuite.cronLabels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "weldsuite.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: cron
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: weldsuite
{{- end }}

{{/*
The migration Job's labels: the release's, with its own component, so the
Service, the PodDisruptionBudget and the NetworkPolicy (which select the api
component) never pick its pod.
*/}}
{{- define "weldsuite.migrateLabels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "weldsuite.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: migrate
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: weldsuite
{{- end }}

{{- define "weldsuite.signPortal.fullname" -}}
{{- printf "%s-sign-portal" (include "weldsuite.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "weldsuite.signPortal.selectorLabels" -}}
app.kubernetes.io/name: {{ include "weldsuite.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: sign-portal
{{- end }}

{{- define "weldsuite.signPortal.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "weldsuite.signPortal.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.signPortal.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: weldsuite
{{- end }}

{{- /* Where the portal reaches the server: its Service, unless set. */ -}}
{{- define "weldsuite.signPortal.backendUrl" -}}
{{- default (printf "http://%s.%s.svc:%v" (include "weldsuite.fullname" .) .Release.Namespace .Values.service.port) .Values.signPortal.backendUrl }}
{{- end }}

{{/*
The Secret the migration Job reads. A hook runs before the release's own
resources exist, so a chart-made Secret (secret.values) gets a hook copy.
*/}}
{{- define "weldsuite.migrateSecretName" -}}
{{- if .Values.secret.existingSecret }}
{{- .Values.secret.existingSecret }}
{{- else }}
{{- printf "%s-migrate" (include "weldsuite.fullname" .) }}
{{- end }}
{{- end }}
