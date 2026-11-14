{{/* The MTA (`weldsuite mta`, weldsuite-documentation/plans/eu-mail-service.md): component
mta, so the API's Service, PDB and NetworkPolicy (component api) never
select its pods. */}}
{{- define "weldsuite.mta.selectorLabels" -}}
app.kubernetes.io/name: {{ include "weldsuite.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: mta
{{- end }}

{{- define "weldsuite.mta.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "weldsuite.mta.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: weldsuite
{{- end }}

{{- define "weldsuite.mta.fullname" -}}
{{- printf "%s-mta" (include "weldsuite.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "weldsuite.mta.apiName" -}}
{{- printf "%s-mta-api" (include "weldsuite.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* The Secret with the MTA's keys: mta.existingSecret, else the release's. */}}
{{- define "weldsuite.mta.secretName" -}}
{{- default (include "weldsuite.secretName" .) .Values.mta.existingSecret }}
{{- end }}

{{/*
The namespace the MTA runs in: mta.namespace, else the release's. The MTA
runs on the host network, which Pod Security's baseline and restricted levels
forbid, so a cluster that enforces them puts it in a namespace labelled
privileged (as LiveKit), apart from the platform.
*/}}
{{- define "weldsuite.mta.namespace" -}}
{{- default .Release.Namespace .Values.mta.namespace }}
{{- end }}

{{/*
The Secret, in the release's namespace, the server, consume and the cron jobs
read MTA_API_SECRET and the submission passwords from: mta.clientSecret, else
the MTA's own Secret (one namespace).
*/}}
{{- define "weldsuite.mta.clientSecretName" -}}
{{- default (include "weldsuite.mta.secretName" .) .Values.mta.clientSecret }}
{{- end }}

{{/* The kubernetes.io/tls Secret the bounce MX's STARTTLS reads. */}}
{{- define "weldsuite.mta.inboundTlsSecret" -}}
{{- default (printf "%s-inbound-tls" (include "weldsuite.mta.fullname" .)) .Values.mta.inbound.tls.existingSecret }}
{{- end }}

{{/* The one submission offers STARTTLS with: its own, or the bounce MX's. */}}
{{- define "weldsuite.mta.submissionTlsSecret" -}}
{{- default (include "weldsuite.mta.inboundTlsSecret" .) .Values.mta.submission.tls.existingSecret }}
{{- end }}

{{/* The pools' names, comma separated (pools are a list of maps). */}}
{{- define "weldsuite.mta.poolNames" -}}
{{- $names := list -}}
{{- range .Values.mta.pools -}}
{{- $names = append $names .name -}}
{{- end -}}
{{- join "," $names -}}
{{- end }}

{{/* Fail early on a configuration the MTA would refuse at start. */}}
{{- define "weldsuite.mta.check" -}}
{{- with .Values.mta }}
{{- if not .pools }}
{{- fail "mta.enabled needs mta.pools: at least one pool (system, customer)" }}
{{- end }}
{{- $seen := dict }}
{{- range .pools }}
{{- if not (regexMatch "^[a-z][a-z0-9]{0,15}$" (.name | default "")) }}
{{- fail (printf "mta.pools: %q is not a pool name (lowercase letters and digits, as OpenTofu's mail_pools)" (.name | default "")) }}
{{- end }}
{{- if hasKey $seen .name }}
{{- fail (printf "mta.pools: %s is listed twice" .name) }}
{{- end }}
{{- $_ := set $seen .name true }}
{{- end }}
{{- if and .inbound.enabled (not .bounceDomain) }}
{{- fail "mta.inbound.enabled needs mta.bounceDomain: the bounce MX only answers for that domain" }}
{{- end }}
{{- end }}
{{- if ne (include "weldsuite.mta.namespace" .) .Release.Namespace }}
{{- if not .Values.mta.existingSecret }}
{{- fail "mta.namespace apart from the release's needs mta.existingSecret: a Secret in that namespace with the MTA's keys" }}
{{- end }}
{{- if and .Values.mta.wireServer (not .Values.mta.clientSecret) }}
{{- fail "mta.namespace apart from the release's needs mta.clientSecret: a Secret in the release's namespace with MTA_API_SECRET and the submission passwords" }}
{{- end }}
{{- end }}
{{- if and (not .Values.secret.existingSecret) (not .Values.mta.existingSecret) }}
{{- $keys := list "MTA_DATABASE_URL" "MTA_KEY" "MTA_API_SECRET" }}
{{- range .Values.mta.pools }}
{{- $keys = append $keys (printf "MTA_SUBMISSION_PASSWORD_%s" (upper .name)) }}
{{- end }}
{{- range $keys }}
{{- if not (hasKey $.Values.secret.values .) }}
{{- fail (printf "mta.enabled needs %s in the Secret (secret.values, secret.existingSecret or mta.existingSecret)" .) }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
What the containers that send mail get with mta.enabled and mta.wireServer
(the server, consume and the cron jobs): the MTA's API for the mail domain
routes, and SMTP_URL (system mail, pool system) and MAIL_SMTP_URL (customer
mail, pool customer) on the submission Service. Each password is declared
before the URL that expands it ($(VAR) only sees variables listed earlier).
A URL a chart-made Secret already holds (secret.values) is left to it; with
an existing Secret, turn wireServer off to keep its SMTP_URL and
MAIL_SMTP_URL.
*/}}
{{- define "weldsuite.mta.clientEnv" -}}
{{- if and .Values.mta.enabled .Values.mta.wireServer }}
{{- $secret := include "weldsuite.mta.clientSecretName" . }}
{{- $namespace := include "weldsuite.mta.namespace" . -}}
- name: MTA_API_URL
  value: {{ printf "http://%s.%s.svc:8025" (include "weldsuite.mta.apiName" .) $namespace | quote }}
- name: MTA_API_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ $secret }}
      key: MTA_API_SECRET
{{- /* The records a customer domain publishes: MX to Haraka, SPF include of the mail nodes. */}}
{{- if and .Values.mailInbound.enabled .Values.mailInbound.haraka.hostname }}
- name: MAIL_MX_HOST
  value: {{ .Values.mailInbound.haraka.hostname | quote }}
{{- end }}
{{- with .Values.mta.spfInclude }}
- name: MAIL_SPF_INCLUDE
  value: {{ . | quote }}
{{- end }}
{{- range $pool, $url := dict "system" "SMTP_URL" "customer" "MAIL_SMTP_URL" }}
{{- include "weldsuite.mta.poolSmtpEnv" (dict "root" $ "pool" $pool "url" $url) }}
{{- end }}
{{- end }}
{{- end }}

{{/*
One pool's submission URL for a pod that sends through the MTA: the pool's
password from the client Secret, then the URL built from it. Empty unless the
MTA is on and wired (mta.wireServer), has the pool, and the Secret's values
don't set the URL themselves. The server, consume and the cron jobs take both
pools (clientEnv); the admin console takes the system pool's SMTP_URL.
Called with (dict "root" $ "pool" "system" "url" "SMTP_URL").
*/}}
{{- define "weldsuite.mta.poolSmtpEnv" -}}
{{- $root := .root }}
{{- $values := $root.Values }}
{{- if and $values.mta.enabled $values.mta.wireServer (has .pool (splitList "," (include "weldsuite.mta.poolNames" $root))) (not (hasKey $values.secret.values .url)) }}
{{- $submission := printf "%s.%s.svc:%v" (include "weldsuite.mta.fullname" $root) (include "weldsuite.mta.namespace" $root) $values.mta.submission.service.port }}
- name: MTA_SUBMISSION_PASSWORD_{{ upper .pool }}
  valueFrom:
    secretKeyRef:
      name: {{ include "weldsuite.mta.clientSecretName" $root }}
      key: MTA_SUBMISSION_PASSWORD_{{ upper .pool }}
- name: {{ .url }}
  value: {{ printf "smtp://%s:$(MTA_SUBMISSION_PASSWORD_%s)@%s" .pool (upper .pool) $submission | quote }}
{{- end }}
{{- end }}
