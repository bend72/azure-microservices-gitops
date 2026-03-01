# ── helm/services/catalog/templates/_helpers.tpl ─────────────────────────────
# (Go template — stored without YAML separators in a real chart)
#
# {{- define "catalog.fullname" -}}
# {{- printf "%s-%s" .Release.Name .Chart.Name | trunc 63 | trimSuffix "-" }}
# {{- end }}
#
# {{- define "catalog.labels" -}}
# helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
# app.kubernetes.io/name: {{ .Chart.Name }}
# app.kubernetes.io/instance: {{ .Release.Name }}
# app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
# app.kubernetes.io/managed-by: {{ .Release.Service }}
# {{- end }}
#
# {{- define "catalog.selectorLabels" -}}
# app.kubernetes.io/name: {{ .Chart.Name }}
# app.kubernetes.io/instance: {{ .Release.Name }}
# {{- end }}