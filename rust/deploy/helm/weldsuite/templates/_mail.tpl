{{/* The inbound MX (Haraka, ADR MAIL-010): component mx, so the API's
Service, PDB and NetworkPolicy (component api) never select its pods. */}}
{{- define "weldsuite.mx.selectorLabels" -}}
app.kubernetes.io/name: {{ include "weldsuite.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: mx
{{- end }}

{{- define "weldsuite.mx.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "weldsuite.mx.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.mailInbound.haraka.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: weldsuite
{{- end }}

{{- define "weldsuite.mx.fullname" -}}
{{- printf "%s-mx" (include "weldsuite.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* The kubernetes.io/tls Secret Haraka's STARTTLS reads. */}}
{{- define "weldsuite.mx.tlsSecret" -}}
{{- default (printf "%s-tls" (include "weldsuite.mx.fullname" .)) .Values.mailInbound.haraka.tls.existingSecret }}
{{- end }}

{{/* The consumer's settings for the inbound subscriber. */}}
{{- define "weldsuite.mailInbound.consumeEnv" -}}
{{- with .Values.mailInbound }}
- name: S3_BUCKET_MAIL
  value: {{ .bucket | quote }}
- name: NATS_MAIL_INBOUND_STREAM
  value: {{ .stream | quote }}
- name: NATS_MAIL_INBOUND_SUBJECT
  value: {{ .subject | quote }}
- name: NATS_MAIL_INBOUND_DLQ_STREAM
  value: {{ .deadLetterStream | quote }}
{{- with .publicUrl }}
- name: R2_PUBLIC_URL
  value: {{ . | quote }}
{{- end }}
{{- end }}
{{- end }}

{{/* Haraka's config files (ConfigMap data): the hostname, the plugin list
and connection.ini with the load balancer's PROXY protocol addresses. */}}
{{- define "weldsuite.mx.config" -}}
me: {{ required "mailInbound.haraka.hostname is required (the MX's name, mx.<domain>)" .Values.mailInbound.haraka.hostname | quote }}
plugins: |
  {{- if .Values.mailInbound.haraka.tls.enabled }}
  tls
  {{- end }}
  spf
  dkim
  weldsuite_rcpt
  weldsuite_auth_results
  weldsuite_queue
connection.ini: |
  [main]

  [haproxy]
  ; The PROXY protocol from the load balancer only: SPF needs the client's address.
  enabled={{ if .Values.mailInbound.haraka.proxyProtocolHosts }}true{{ else }}false{{ end }}
  {{- range .Values.mailInbound.haraka.proxyProtocolHosts }}
  hosts[] = {{ . }}
  {{- else }}
  hosts[] =
  {{- end }}

  [headers]
  add_received=true
  clean_auth_results=true
  show_version=false
  max_lines=1000
  max_received=100

  [max]
  bytes={{ int64 .Values.mailInbound.maxMessageBytes }}
  mime_parts=1000
  line_length=512
  data_line_length=992

  [message]
  helo=WeldMail
  close=closing connection

  [uuid]
  banner_chars=6
  deny_chars=0
{{- end }}
