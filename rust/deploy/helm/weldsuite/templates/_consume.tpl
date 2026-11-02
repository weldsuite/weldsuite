{{/* Labels of the `weldsuite consume` pods: component consume, so the API's
Service, PDB and NetworkPolicy (component api) never select them. */}}
{{- define "weldsuite.consume.selectorLabels" -}}
app.kubernetes.io/name: {{ include "weldsuite.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: consume
{{- end }}

{{- define "weldsuite.consume.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "weldsuite.consume.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: weldsuite
{{- end }}

{{- define "weldsuite.consume.fullname" -}}
{{- printf "%s-consume" (include "weldsuite.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}
