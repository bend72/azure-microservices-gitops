import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as azure_native from "@pulumi/azure-native";

// ---------------------------------------------------------------------------
// Wire up to stage2 + stage3 outputs
// ---------------------------------------------------------------------------
const cfg    = new pulumi.Config();
const gitOrg = cfg.require("gitOrg");   // e.g. "contoso"
const gitRepo = cfg.get("gitRepo") ?? "azure-microservices-gitops";
const gitBranch = cfg.get("gitBranch") ?? "main";

const stage2 = new pulumi.StackReference("org/azure-microservices-stage2/demo");
const aksClusterName   = stage2.getOutput("aksClusterName");
const aksResourceGroup = stage2.getOutput("aksResourceGroup");

const creds = azure_native.containerservice.listManagedClusterUserCredentialsOutput({
  resourceName:      aksClusterName.apply(n => String(n)),
  resourceGroupName: aksResourceGroup.apply(n => String(n)),
});

const kubeconfig = creds.kubeconfigs.apply(kcs =>
  Buffer.from(kcs[0].value, "base64").toString()
);

const k8sProvider = new k8s.Provider("k8s-stage4", { kubeconfig });

// ---------------------------------------------------------------------------
// ArgoCD
// ---------------------------------------------------------------------------
const argoCdNs = new k8s.core.v1.Namespace("argocd", {
  metadata: { name: "argocd" },
}, { provider: k8sProvider });

const argocd = new k8s.helm.v3.Release("argocd", {
  name:           "argocd",
  namespace:      argoCdNs.metadata.name,
  chart:          "argo-cd",
  repositoryOpts: { repo: "https://argoproj.github.io/argo-helm" },
  version:        "6.11.1",
  values: {
    global: {
      domain: pulumi.interpolate`argocd.${gitOrg}.internal`,
    },
    configs: {
      params: {
        "server.insecure": true,  // TLS terminated at ingress
      },
      cm: {
        // Resource tracking via annotation (preferred for multi-tenancy)
        "application.resourceTrackingMethod": "annotation",
        // Enable Helm + Kustomize
        "kustomize.enabled":     "true",
        "helm.enabled":          "true",
        // SSO — wire to Entra ID (client-id patched by Backstage template)
        "oidc.config": `
name: Azure AD
issuer: https://login.microsoftonline.com/TENANT_ID/v2.0
clientID: ARGOCD_CLIENT_ID
clientSecret: $argocd-azure-secret:oidc.azure.clientSecret
requestedScopes:
  - openid
  - profile
  - email
requestedIDTokenClaims:
  groups:
    essential: true
`,
      },
      rbac: {
        "policy.default": "role:readonly",
        "policy.csv": `
g, platform-admins,    role:admin
g, platform-engineers, role:admin
g, dev-team,           role:readonly
`,
      },
    },
    server: {
      replicas:  1,
      resources: {
        requests: { cpu: "100m", memory: "256Mi" },
        limits:   { cpu: "500m", memory: "512Mi" },
      },
      ingress: {
        enabled: true,
        ingressClassName: "nginx",
        annotations: {
          "nginx.ingress.kubernetes.io/force-ssl-redirect": "true",
          "nginx.ingress.kubernetes.io/backend-protocol": "HTTP",
        },
        hostname: pulumi.interpolate`argocd.${gitOrg}.internal`,
      },
    },
    repoServer: {
      replicas: 1,
      // Enable Helm secrets plugin via init container
      initContainers: [{
        name:  "download-tools",
        image: "alpine:3.19",
        command: ["sh", "-c", [
          "wget -qO /tools/sops https://github.com/getsops/sops/releases/download/v3.8.1/sops-v3.8.1.linux.amd64",
          "chmod +x /tools/sops",
        ].join(" && ")],
        volumeMounts: [{ name: "custom-tools", mountPath: "/tools" }],
      }],
      volumes: [{ name: "custom-tools", emptyDir: {} }],
      volumeMounts: [{ name: "custom-tools", mountPath: "/usr/local/bin/sops", subPath: "sops" }],
    },
    applicationSet: {
      enabled: true,
      replicas: 1,
    },
    notifications: {
      enabled: true,
    },
  },
}, { provider: k8sProvider, dependsOn: [argoCdNs] });

// ---------------------------------------------------------------------------
// ArgoCD App-of-Apps bootstrap
// (this CR tells ArgoCD to watch the gitops repo and self-manage everything)
// ---------------------------------------------------------------------------
const appOfApps = new k8s.apiextensions.CustomResource("app-of-apps", {
  apiVersion: "argoproj.io/v1alpha1",
  kind:       "Application",
  metadata: {
    name:      "app-of-apps",
    namespace: "argocd",
    annotations: {
      "argocd.argoproj.io/sync-wave": "-1",
    },
  },
  spec: {
    project: "default",
    source: {
      repoURL:        pulumi.interpolate`https://github.com/${gitOrg}/${gitRepo}`,
      targetRevision: gitBranch,
      path:           "argocd/apps",   // contains all child Application manifests
    },
    destination: {
      server:    "https://kubernetes.default.svc",
      namespace: "argocd",
    },
    syncPolicy: {
      automated: {
        prune:    true,
        selfHeal: true,
      },
      syncOptions: [
        "CreateNamespace=true",
        "PrunePropagationPolicy=foreground",
        "RespectIgnoreDifferences=true",
      ],
      retry: {
        limit: 5,
        backoff: {
          duration:    "5s",
          factor:      2,
          maxDuration: "3m",
        },
      },
    },
  },
}, { provider: k8sProvider, dependsOn: [argocd] });

// ---------------------------------------------------------------------------
// OPA Gatekeeper
// ---------------------------------------------------------------------------
const gatekeeperNs = new k8s.core.v1.Namespace("gatekeeper-system", {
  metadata: {
    name:   "gatekeeper-system",
    labels: { "admission.gatekeeper.sh/ignore": "no-self-manage" },
  },
}, { provider: k8sProvider });

const gatekeeper = new k8s.helm.v3.Release("gatekeeper", {
  name:           "gatekeeper",
  namespace:      gatekeeperNs.metadata.name,
  chart:          "gatekeeper",
  repositoryOpts: { repo: "https://open-policy-agent.github.io/gatekeeper/charts" },
  version:        "3.17.1",
  values: {
    replicas: 2,
    auditInterval: 60,
    constraintViolationsLimit: 20,
    logLevel: "INFO",
    metricsBackend: "prometheus",
    resources: {
      requests: { cpu: "100m", memory: "256Mi" },
      limits:   { cpu: "1",   memory: "512Mi" },
    },
  },
}, { provider: k8sProvider, dependsOn: [gatekeeperNs] });

// ── Gatekeeper constraint templates ──────────────────────────────────────────

// 1. Require resource requests/limits on all pods
const requireResourcesTemplate = new k8s.apiextensions.CustomResource("ct-require-resources", {
  apiVersion: "templates.gatekeeper.sh/v1",
  kind:       "ConstraintTemplate",
  metadata:   { name: "k8srequiredresources" },
  spec: {
    crd: {
      spec: {
        names: { kind: "K8sRequiredResources" },
        validation: {
          openAPIV3Schema: {
            type: "object",
            properties: {
              containers: {
                type: "array",
                items: { type: "string" },
              },
            },
          },
        },
      },
    },
    targets: [{
      target: "admission.k8s.gatekeeper.sh",
      rego: `
package k8srequiredresources
violation[{"msg": msg}] {
  container := input.review.object.spec.containers[_]
  not container.resources.requests.cpu
  msg := sprintf("Container <%v> must set cpu requests", [container.name])
}
violation[{"msg": msg}] {
  container := input.review.object.spec.containers[_]
  not container.resources.limits.memory
  msg := sprintf("Container <%v> must set memory limits", [container.name])
}
`,
    }],
  },
}, { provider: k8sProvider, dependsOn: [gatekeeper] });

// 2. Disallow latest image tag
const disallowLatestTemplate = new k8s.apiextensions.CustomResource("ct-disallow-latest", {
  apiVersion: "templates.gatekeeper.sh/v1",
  kind:       "ConstraintTemplate",
  metadata:   { name: "k8sdisallowedtags" },
  spec: {
    crd: {
      spec: {
        names: { kind: "K8sDisallowedTags" },
        validation: {
          openAPIV3Schema: {
            type: "object",
            properties: {
              tags: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
    targets: [{
      target: "admission.k8s.gatekeeper.sh",
      rego: `
package k8sdisallowedtags
violation[{"msg": msg}] {
  container := input.review.object.spec.containers[_]
  tag := [t | t = split(container.image, ":")[1]]
  count(tag) == 0
  msg := sprintf("Container <%v> has no image tag — 'latest' is implied and disallowed", [container.name])
}
violation[{"msg": msg}] {
  container := input.review.object.spec.containers[_]
  endswith(container.image, ":latest")
  msg := sprintf("Container <%v> uses 'latest' tag — pin to a digest or semver", [container.name])
}
`,
    }],
  },
}, { provider: k8sProvider, dependsOn: [gatekeeper] });

// Enforce constraints on workload namespaces
const requireResourcesConstraint = new k8s.apiextensions.CustomResource("c-require-resources", {
  apiVersion: "constraints.gatekeeper.sh/v1beta1",
  kind:       "K8sRequiredResources",
  metadata:   { name: "must-have-resource-constraints" },
  spec: {
    enforcementAction: "warn",  // warn first, flip to deny after onboarding
    match: {
      kinds: [{ apiGroups: ["apps"], kinds: ["Deployment", "StatefulSet", "DaemonSet"] }],
      namespaces: ["catalog", "ordering", "basket", "identity", "payment", "notification"],
    },
  },
}, { provider: k8sProvider, dependsOn: [requireResourcesTemplate] });

const disallowLatestConstraint = new k8s.apiextensions.CustomResource("c-disallow-latest", {
  apiVersion: "constraints.gatekeeper.sh/v1beta1",
  kind:       "K8sDisallowedTags",
  metadata:   { name: "no-latest-images" },
  spec: {
    enforcementAction: "deny",
    match: {
      kinds: [{ apiGroups: ["apps"], kinds: ["Deployment"] }],
      namespaces: ["catalog", "ordering", "basket", "identity", "payment", "notification"],
    },
    parameters: { tags: ["latest"] },
  },
}, { provider: k8sProvider, dependsOn: [disallowLatestTemplate] });

// ---------------------------------------------------------------------------
// OpenTelemetry Operator + Collector
// ---------------------------------------------------------------------------
const otelNs = new k8s.core.v1.Namespace("opentelemetry", {
  metadata: { name: "opentelemetry" },
}, { provider: k8sProvider });

const otelOperator = new k8s.helm.v3.Release("otel-operator", {
  name:           "opentelemetry-operator",
  namespace:      otelNs.metadata.name,
  chart:          "opentelemetry-operator",
  repositoryOpts: { repo: "https://open-telemetry.github.io/opentelemetry-helm-charts" },
  version:        "0.61.0",
  values: {
    manager: {
      collectorImage: { repository: "otel/opentelemetry-collector-contrib" },
    },
    admissionWebhooks: {
      certManager: { enabled: false },
      autoGenerateCert: { enabled: true },
    },
  },
}, { provider: k8sProvider, dependsOn: [otelNs] });

// Collector CR — fan-in from all services, export to Azure Monitor + Prometheus
const otelCollector = new k8s.apiextensions.CustomResource("otel-collector", {
  apiVersion: "opentelemetry.io/v1alpha1",
  kind:       "OpenTelemetryCollector",
  metadata: { name: "otel-collector", namespace: "opentelemetry" },
  spec: {
    mode:     "deployment",
    replicas: 2,
    resources: {
      requests: { cpu: "200m", memory: "256Mi" },
      limits:   { cpu: "1",   memory: "512Mi" },
    },
    config: `
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318
  prometheus:
    config:
      scrape_configs:
        - job_name: dapr-metrics
          scrape_interval: 15s
          kubernetes_sd_configs:
            - role: pod
          relabel_configs:
            - source_labels: [__meta_kubernetes_pod_annotation_dapr_io_enabled]
              action: keep
              regex: "true"
            - source_labels: [__meta_kubernetes_pod_ip]
              target_label: __address__
              replacement: "$1:9090"

processors:
  batch:
    timeout: 10s
    send_batch_size: 1024
  memory_limiter:
    check_interval: 5s
    limit_percentage: 80
    spike_limit_percentage: 25
  resource:
    attributes:
      - key: service.namespace
        from_attribute: k8s.namespace.name
        action: insert
      - key: deployment.environment
        value: demo
        action: insert
  k8sattributes:
    auth_type: serviceAccount
    passthrough: false
    extract:
      metadata:
        - k8s.pod.name
        - k8s.deployment.name
        - k8s.namespace.name
        - k8s.node.name

exporters:
  azuremonitor:
    instrumentation_key: "\${APPINSIGHTS_INSTRUMENTATIONKEY}"
  prometheus:
    endpoint: "0.0.0.0:8889"
    namespace: otel
  debug:
    verbosity: normal

service:
  pipelines:
    traces:
      receivers:  [otlp]
      processors: [memory_limiter, k8sattributes, resource, batch]
      exporters:  [azuremonitor, debug]
    metrics:
      receivers:  [otlp, prometheus]
      processors: [memory_limiter, k8sattributes, resource, batch]
      exporters:  [azuremonitor, prometheus]
    logs:
      receivers:  [otlp]
      processors: [memory_limiter, k8sattributes, resource, batch]
      exporters:  [azuremonitor, debug]
`,
  },
}, { provider: k8sProvider, dependsOn: [otelOperator] });

// Instrumentation CR — auto-instrument .NET + Node.js pods via annotation
const otelInstrumentation = new k8s.apiextensions.CustomResource("otel-instrumentation", {
  apiVersion: "opentelemetry.io/v1alpha1",
  kind:       "Instrumentation",
  metadata: { name: "auto-instrumentation", namespace: "default" },
  spec: {
    exporter: {
      endpoint: "http://otel-collector-collector.opentelemetry.svc.cluster.local:4317",
    },
    propagators: ["tracecontext", "baggage", "b3"],
    sampler: {
      type:     "parentbased_traceidratio",
      argument: "1.0",
    },
    dotnet: {
      image: "ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-dotnet:1.3.0",
    },
    nodejs: {
      image: "ghcr.io/open-telemetry/opentelemetry-operator/autoinstrumentation-nodejs:0.50.0",
    },
  },
}, { provider: k8sProvider, dependsOn: [otelOperator] });

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
export const argoCdVersion   = argocd.version;
export const gatekeeperNsOut = gatekeeperNs.metadata.name;
export const otelNsOut       = otelNs.metadata.name;
export const argoCdNote      = pulumi.interpolate`kubectl port-forward -n argocd svc/argocd-server 8080:80 — then visit http://localhost:8080`;
export const argoCdPassword  = pulumi.interpolate`kubectl get secret argocd-initial-admin-secret -n argocd -o jsonpath='{.data.password}' | base64 -d`;
