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
(rust/bins/weldsuite/src/config.rs). Without the bundled dependencies'
settings, which weldsuite.env adds.
*/}}
{{- define "weldsuite.envBase" -}}
- name: PORT
  value: "8080"
{{- /* What /version reports: the chart release and the image it installs. */}}
- name: WELDSUITE_RELEASE
  value: {{ .Chart.Version | quote }}
- name: WELDSUITE_BUILD
  value: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
- name: ENVIRONMENT
  value: {{ .Values.config.environment | quote }}
- name: LOG_FORMAT
  value: {{ .Values.config.logFormat | quote }}
- name: RUST_LOG
  value: {{ .Values.config.logLevel | quote }}
- name: PERMISSIONS_APP_ENFORCE
  value: {{ .Values.config.permissionsAppEnforce | toString | quote }}
- name: TRUSTED_PROXIES
  value: {{ .Values.config.trustedProxies | default 1 | toString | quote }}
{{- if .Values.consume.enabled }}
{{- /* WeldReach's send sweep queues on NATS for the consume role's reach-send subscriber. */}}
- name: REACH_SEND_QUEUE
  value: "nats"
{{- /* And the warmup dispatch for its reach-warmup-send / -engage subscribers. */}}
- name: REACH_WARMUP_QUEUE
  value: "nats"
{{- end }}
{{- with .Values.config.edition }}
{{- if not (has . (list "eu" "self-hosted")) }}
{{- fail "config.edition must be eu or self-hosted" }}
{{- end }}
- name: EDITION
  value: {{ . | quote }}
{{- end }}
{{- with .Values.config.publicEnv }}
- name: PUBLIC_ENV
  value: {{ toJson . | quote }}
{{- end }}
{{- with .Values.config.video }}
{{- if eq (.provider | default "") "livekit" }}
- name: VIDEO_PROVIDER
  value: "livekit"
- name: LIVEKIT_URL
  value: {{ required "config.video.livekit.url is required with config.video.provider livekit" .livekit.url | quote }}
{{- with .livekit.apiUrl }}
- name: LIVEKIT_API_URL
  value: {{ . | quote }}
{{- end }}
{{- with .livekit.tokenTtlSeconds }}
- name: LIVEKIT_TOKEN_TTL_SECONDS
  value: {{ . | toString | quote }}
{{- end }}
{{- else if .provider }}
{{- if ne .provider "realtimekit" }}
{{- fail "config.video.provider must be livekit or realtimekit" }}
{{- end }}
- name: VIDEO_PROVIDER
  value: "realtimekit"
{{- end }}
{{- end }}
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
{{- with .oidc.mobileClientId }}
- name: OIDC_MOBILE_CLIENT_ID
  value: {{ . | toString | quote }}
{{- end }}
{{- with .oidc.signIn }}
{{- if and (eq . "platform") (not $.Values.config.identity.zitadel.apiUrl) }}
{{- fail "config.auth.oidc.signIn platform needs config.identity.zitadel.apiUrl" }}
{{- end }}
- name: OIDC_SIGN_IN
  value: {{ . | quote }}
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
  value: {{ or .Values.config.nats.ensureStreams .Values.bundle.nats | toString | quote }}
{{- with .Values.config.files }}
{{- if and .endpoint (not $.Values.bundle.objectStorage) }}
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
{{- with .publicUrl }}
- name: S3_PUBLIC_URL
  value: {{ trimSuffix "/" . | quote }}
{{- end }}
{{- end }}
{{- with .Values.config.jobs }}
{{- $ingressUrl := include "weldsuite.restate.ingressUrl" $ }}
{{- $adminUrl := include "weldsuite.restate.adminUrl" $ }}
{{- if $ingressUrl }}
- name: RESTATE_INGRESS_URL
  value: {{ $ingressUrl | quote }}
- name: JOBS_PORT
  value: {{ .port | quote }}
{{- if $adminUrl }}
- name: RESTATE_ADMIN_URL
  value: {{ $adminUrl | quote }}
- name: RESTATE_DEPLOYMENT_URI
  value: {{ printf "http://%s-jobs.%s.svc:%v" (include "weldsuite.fullname" $) $.Release.Namespace .port | quote }}
{{- end }}
{{- end }}
{{- end }}
{{- if .Values.collabRooms.enabled }}
- name: COLLAB_ROOMS_URLS
  value: {{ include "weldsuite.collabRooms.urls" . | quote }}
{{- end }}
{{- with .Values.config.mail.from }}
- name: SYSTEM_EMAIL_FROM
  value: {{ . | quote }}
{{- end }}
{{- with .Values.config.mail.freeAddressDomain }}
- name: WELDMAIL_DOMAIN
  value: {{ . | quote }}
{{- end }}
{{- if .Values.clerkJwks.enabled }}
- name: CLERK_JWKS_FILE
  value: /etc/weldsuite/clerk/jwks.json
{{- end }}
{{- with .Values.config.flow.projectPortalUrl }}
- name: PROJECT_PORTAL_URL
  value: {{ . | quote }}
{{- end }}
{{- with (.Values.config.credits | default dict).mollie }}
{{- with .webhookUrl }}
- name: MOLLIE_WEBHOOK_URL
  value: {{ . | quote }}
{{- end }}
{{- with .redirectUrl }}
- name: MOLLIE_REDIRECT_URL
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- with .Values.config.sign.portalUrl }}
- name: SIGN_PORTAL_URL
  value: {{ . | quote }}
{{- end }}
{{- with .Values.config.forms.portalUrl }}
- name: FORMS_PORTAL_URL
  value: {{ . | quote }}
{{- end }}
{{- with .Values.config.forms.botCheckProvider }}
- name: BOT_CHECK_PROVIDER
  value: {{ . | quote }}
{{- end }}
{{- with .Values.config.forms.turnstileSiteKey }}
- name: TURNSTILE_SITE_KEY
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
{{- include "weldsuite.publicUrlEnv" . }}
{{- with .Values.config.extraEnv }}
{{- toYaml . | nindent 0 }}
{{- end }}
{{- end }}

{{- /*
The environment of the server, the consume role and the cron jobs:
weldsuite.envBase plus the bundled dependencies' settings (weldsuite.bundleEnv),
which read the generated Secret. The migration hook Job takes envBase alone:
it runs before that Secret (or a key a newly enabled bundle adds to it)
exists, and needs only the databases.
*/}}
{{- define "weldsuite.env" -}}
{{- include "weldsuite.envBase" . }}
{{- include "weldsuite.bundleEnv" . }}
{{- end }}

{{- /*
config.publicUrl as PUBLIC_URL, and every URL setting that names the
install's own host (the platform, /api, /v1, the webhooks and the WeldPanel
collector are all served there) set to it, unless extraEnv names the setting:
extraEnv wins, without a duplicate entry in the container's env.
*/}}
{{- define "weldsuite.publicUrlEnv" -}}
{{- with .Values.config.publicUrl }}
{{- if not (regexMatch "^https?://[^/?#]+/?$" .) }}
{{- fail (printf "config.publicUrl must be an origin such as https://weldsuite.example.com, got %q" .) }}
{{- end }}
{{- $url := trimSuffix "/" . }}
{{- $named := dict }}
{{- range $.Values.config.extraEnv }}
{{- $_ := set $named (toString .name) true }}
{{- end }}
- name: PUBLIC_URL
  value: {{ $url | quote }}
{{- range list "PUBLIC_APP_URL" "APP_URL" "PLATFORM_URL" "APP_API_PUBLIC_URL" "PUBLIC_API_URL" "CONNECT_API_URL" "CONNECTOR_WEBHOOK_BASE_URL" "WEBHOOK_BASE_URL" "PANEL_COLLECTOR_URL" }}
{{- if not (hasKey $named .) }}
- name: {{ . }}
  value: {{ $url | quote }}
{{- end }}
{{- end }}
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

{{- define "weldsuite.formsPortal.fullname" -}}
{{- printf "%s-forms-portal" (include "weldsuite.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "weldsuite.formsPortal.selectorLabels" -}}
app.kubernetes.io/name: {{ include "weldsuite.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: forms-portal
{{- end }}

{{- define "weldsuite.formsPortal.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "weldsuite.formsPortal.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.formsPortal.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: weldsuite
{{- end }}

{{- define "weldsuite.admin.fullname" -}}
{{- printf "%s-admin" (include "weldsuite.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "weldsuite.admin.selectorLabels" -}}
app.kubernetes.io/name: {{ include "weldsuite.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: admin
{{- end }}

{{- define "weldsuite.admin.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "weldsuite.admin.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.admin.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: weldsuite
{{- end }}

{{- /* Where the admin console reaches the server (its outbound-mail API): the server's Service. */ -}}
{{- define "weldsuite.admin.serverUrl" -}}
{{- printf "http://%s.%s.svc:%v" (include "weldsuite.fullname" .) .Release.Namespace .Values.service.port }}
{{- end }}

{{- define "weldsuite.objectStorage.fullname" -}}
{{- printf "%s-s3" (include "weldsuite.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "weldsuite.objectStorage.selectorLabels" -}}
app.kubernetes.io/name: {{ include "weldsuite.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: object-storage
{{- end }}

{{- define "weldsuite.objectStorage.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "weldsuite.objectStorage.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: weldsuite
{{- end }}

{{- /* Restate's URLs: config.jobs.restate's, else the bundled Restate's. */}}
{{- define "weldsuite.restate.ingressUrl" -}}
{{- if .Values.config.jobs.restate.ingressUrl }}
{{- .Values.config.jobs.restate.ingressUrl }}
{{- else if .Values.bundle.restate }}
{{- printf "http://%s:8080" (include "weldsuite.restate.host" .) }}
{{- end }}
{{- end }}

{{- /* The bundled Restate's Service: its chart names it after nameOverride
(restate-helm's own default), without the release name. */}}
{{- define "weldsuite.restate.host" -}}
{{- default "restate" .Values.restate.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "weldsuite.restate.adminUrl" -}}
{{- if .Values.config.jobs.restate.adminUrl }}
{{- .Values.config.jobs.restate.adminUrl }}
{{- else if .Values.bundle.restate }}
{{- printf "http://%s:9070" (include "weldsuite.restate.host" .) }}
{{- end }}
{{- end }}

{{- /*
The settings of the bundled dependencies (bundle in values.yaml), from the
generated Secret. Explicit env entries, so they win over the same keys in the
release's Secret.
*/}}
{{- define "weldsuite.bundleEnv" -}}
{{- $bundle := .Values.bundle }}
{{- if and (or $bundle.valkey $bundle.nats $bundle.objectStorage) (not .Values.secret.generate) }}
{{- fail "bundle.valkey, bundle.nats and bundle.objectStorage take their credentials from the generated Secret: set secret.generate" }}
{{- end }}
{{- $secret := .Values.secret.generatedName }}
{{- if $bundle.postgres }}
{{- $cluster := include "weldsuite.postgres.fullname" . }}
{{- include "weldsuite.masterDatabaseEnv" . }}
- name: POSTGRES_TENANT_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ $cluster }}-tenant
      key: password
{{- /* One shard, the same cluster; workspaces reach its primary directly. */}}
- name: TENANT_SHARDS
  value: {{ printf `[{"name":"%s","adminUrl":"postgres://tenant:$(POSTGRES_TENANT_PASSWORD)@%s-rw:5432/postgres?sslmode=require","poolerHost":"%s-rw"}]` $cluster $cluster $cluster | quote }}
{{- end }}
{{- if $bundle.valkey }}
- name: VALKEY_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: VALKEY_PASSWORD
- name: VALKEY_URL
  value: {{ printf "redis://default:$(VALKEY_PASSWORD)@%s:6379" (include "weldsuite.subchartHost" (list . "valkey")) | quote }}
{{- end }}
{{- if $bundle.nats }}
- name: NATS_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: NATS_TOKEN
- name: NATS_URL
  value: {{ printf "nats://%s:4222" (include "weldsuite.subchartHost" (list . "nats")) | quote }}
{{- end }}
{{- if $bundle.objectStorage }}
- name: S3_ENDPOINT
  value: {{ printf "http://%s:9000" (include "weldsuite.objectStorage.fullname" .) | quote }}
- name: S3_REGION
  value: "us-east-1"
- name: S3_BUCKET_PRIVATE
  value: {{ .Values.objectStorage.buckets.private | quote }}
- name: S3_BUCKET_PUBLIC
  value: {{ .Values.objectStorage.buckets.public | quote }}
- name: S3_FORCE_PATH_STYLE
  value: "true"
- name: S3_ACCESS_KEY_ID
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: S3_ACCESS_KEY_ID
- name: S3_SECRET_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: S3_SECRET_ACCESS_KEY
- name: S3_ENSURE_BUCKETS
  value: "true"
{{- if not .Values.config.files.publicUrl }}
{{- /* No public endpoint of its own: this server serves the public bucket. */}}
- name: S3_PUBLIC_VIA_SERVER
  value: "true"
{{- with .Values.config.publicUrl }}
- name: S3_PUBLIC_URL
  value: {{ printf "%s/api/storage/public" (trimSuffix "/" .) | quote }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{- /*
A bundled subchart's Service name: its chart's usual fullname (the release
name, or <release>-<name> when the release name doesn't contain it).
Called with (list $ "valkey").
*/}}
{{- define "weldsuite.subchartHost" -}}
{{- $root := index . 0 }}
{{- $name := index . 1 }}
{{- if contains $name $root.Release.Name }}
{{- $root.Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" $root.Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}

{{- /* The keys the generated Secret makes (secret-generated.yaml), as JSON. */}}
{{- define "weldsuite.generatedHexKeys" -}}
{{- toJson (list "DATABASE_ENCRYPTION_KEY" "DATABASE_ENCRYPTION_KEY_V2" "WELDPASS_ROOT_KEY" "WELDREACH_WARMUP_KEY" "ADMIN_SESSION_SECRET") }}
{{- end }}

{{- define "weldsuite.generatedSecretKeys" -}}
{{- toJson (list "SIGN_SESSION_SECRET" "SIGN_PORTAL_SECRET" "STORAGE_SIGNING_KEY" "REALTIME_INTERNAL_SECRET" "WIDGET_TOKEN_SECRET" "COLLAB_ROOMS_SECRET" "INTERNAL_API_SECRET" "MAIL_INBOUND_SECRET" "OUTBOUND_ADMIN_SECRET") }}
{{- end }}

{{- /*
A secretKeyRef for one key, for the pods that take single keys rather than
the whole environment (the sign portal, the admin console, collab-rooms). It
names the Secret the server's value comes from, as weldsuite.envFrom orders
them: the release's Secret when it has the key (secret.values, or the
existing Secret as lookup sees it), else the generated one for a key it
makes. Called with (dict "root" $ "key" "NAME" "optional" true).
*/}}
{{- define "weldsuite.secretKeyRef" -}}
{{- $root := .root }}
{{- $key := .key }}
{{- $name := include "weldsuite.secretName" $root }}
{{- $made := concat (include "weldsuite.generatedHexKeys" $root | fromJsonArray) (include "weldsuite.generatedSecretKeys" $root | fromJsonArray) }}
{{- if and $root.Values.secret.generate (has $key $made) }}
{{- if hasKey ($root.Values.secret.values | default dict) $key }}
{{- else if $root.Values.secret.existingSecret }}
{{- $existing := lookup "v1" "Secret" $root.Release.Namespace $root.Values.secret.existingSecret }}
{{- if not (and $existing $existing.data (hasKey $existing.data $key)) }}
{{- $name = $root.Values.secret.generatedName }}
{{- end }}
{{- else }}
{{- $name = $root.Values.secret.generatedName }}
{{- end }}
{{- end }}
secretKeyRef:
  name: {{ $name }}
  key: {{ $key }}
  {{- if .optional }}
  optional: true
  {{- end }}
{{- end }}

{{- /*
Every pod that runs the binary loads the generated Secret (when there is
one) before the release's own, so a key set in the latter wins.
*/}}
{{- define "weldsuite.envFrom" -}}
{{- if .Values.secret.generate }}
- secretRef:
    name: {{ .Values.secret.generatedName }}
    optional: true
{{- end }}
{{- if include "weldsuite.hasSecret" . }}
- secretRef:
    name: {{ include "weldsuite.secretName" . }}
{{- end }}
{{- end }}

{{- /* Whether the release has a Secret of its own (existing or chart-made). */}}
{{- define "weldsuite.hasSecret" -}}
{{- if or .Values.secret.existingSecret .Values.secret.values }}true{{ end }}
{{- end }}

{{- /*
Whether the migrations run in an init container of the server's pods
instead of the pre-install/pre-upgrade hook Job: with the bundled Postgres,
which doesn't exist yet when the hooks run. Each pod migrates before it
serves; migrate's advisory lock lets one run at a time.
*/}}
{{- define "weldsuite.migrateInPod" -}}
{{- if and .Values.migrations.enabled .Values.bundle.postgres }}true{{ end }}
{{- end }}

{{- /*
DATABASE_URL_MASTER for any pod that opens the master database (the
server's environment, the admin console, collab-rooms): the bundled
Postgres's, from its owner password, else the release's Secret's key.
*/}}
{{- define "weldsuite.masterDatabaseEnv" -}}
{{- if .Values.bundle.postgres }}
{{- $cluster := include "weldsuite.postgres.fullname" . }}
- name: POSTGRES_OWNER_PASSWORD
  valueFrom:
    secretKeyRef:
      name: {{ $cluster }}-owner
      key: password
- name: DATABASE_URL_MASTER
  value: {{ printf "postgres://weldsuite:$(POSTGRES_OWNER_PASSWORD)@%s-rw:5432/weldsuite_master?sslmode=require" $cluster | quote }}
{{- else }}
- name: DATABASE_URL_MASTER
  valueFrom:
    secretKeyRef:
      name: {{ include "weldsuite.secretName" . }}
      key: DATABASE_URL_MASTER
{{- end }}
{{- end }}

{{- define "weldsuite.postgres.fullname" -}}
{{- printf "%s-pg" (include "weldsuite.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "weldsuite.collabRooms.fullname" -}}
{{- printf "%s-collab-rooms" (include "weldsuite.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "weldsuite.collabRooms.selectorLabels" -}}
app.kubernetes.io/name: {{ include "weldsuite.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: collab-rooms
{{- end }}

{{- define "weldsuite.collabRooms.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "weldsuite.collabRooms.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.collabRooms.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: weldsuite
{{- end }}

{{- /* Every collab-rooms pod's URL, comma separated: the server routes rooms over them. */ -}}
{{- define "weldsuite.collabRooms.urls" -}}
{{- $svc := include "weldsuite.collabRooms.fullname" . -}}
{{- $urls := list -}}
{{- range $i := until (int .Values.collabRooms.replicaCount) -}}
{{- $urls = append $urls (printf "http://%s-%d.%s.%s.svc:8090" $svc $i $svc $.Release.Namespace) -}}
{{- end -}}
{{- join "," $urls -}}
{{- end }}

{{- /* Where the portal reaches the server: its Service, unless set. */ -}}
{{- define "weldsuite.signPortal.backendUrl" -}}
{{- default (printf "http://%s.%s.svc:%v" (include "weldsuite.fullname" .) .Release.Namespace .Values.service.port) .Values.signPortal.backendUrl }}
{{- end }}

{{- define "weldsuite.formsPortal.backendUrl" -}}
{{- default (printf "http://%s.%s.svc:%v" (include "weldsuite.fullname" .) .Release.Namespace .Values.service.port) .Values.formsPortal.backendUrl }}
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

{{/*
METRICS_ADDR for the server and consume: /metrics on every address at the
metrics port, apart from the API's, or off. The MTA sets its own: it runs on
the host network, so it listens on the node's private address only.
*/}}
{{- define "weldsuite.metricsEnv" -}}
- name: METRICS_ADDR
  value: {{ ternary (printf "0.0.0.0:%v" .Values.metrics.port) "off" .Values.metrics.enabled | quote }}
{{- end }}

{{/* The container port Prometheus scrapes, with metrics.enabled. */}}
{{- define "weldsuite.metricsPort" -}}
{{- if .Values.metrics.enabled -}}
- name: metrics
  containerPort: {{ .Values.metrics.port }}
  protocol: TCP
{{- end }}
{{- end }}

{{/* The metrics port on a Service, with metrics.enabled. */}}
{{- define "weldsuite.metricsServicePort" -}}
{{- if .Values.metrics.enabled -}}
- name: metrics
  port: {{ .Values.metrics.port }}
  targetPort: metrics
  protocol: TCP
{{- end }}
{{- end }}
