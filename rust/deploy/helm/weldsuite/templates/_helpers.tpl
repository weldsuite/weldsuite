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
