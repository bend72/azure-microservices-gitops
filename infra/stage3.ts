import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as azure_native from "@pulumi/azure-native";

// ---------------------------------------------------------------------------
// Wire up to stage2 outputs
// ---------------------------------------------------------------------------
const stage2 = new pulumi.StackReference("org/azure-microservices-stage2/demo");

const aksClusterName   = stage2.getOutput("aksClusterName");
const aksResourceGroup = stage2.getOutput("aksResourceGroup");
const serviceBusNs     = stage2.getOutput("serviceBusNs");
const keyVaultUri      = stage2.getOutput("keyVaultUri");

// Retrieve kubeconfig from the existing AKS cluster
const creds = azure_native.containerservice.listManagedClusterUserCredentialsOutput({
  resourceName:      aksClusterName.apply(n => String(n)),
  resourceGroupName: aksResourceGroup.apply(n => String(n)),
});

const kubeconfig = creds.kubeconfigs.apply(kcs => {
  const raw = kcs[0].value;
  return Buffer.from(raw, "base64").toString();
});

const k8sProvider = new k8s.Provider("k8s-stage3", { kubeconfig });

// ---------------------------------------------------------------------------
// Helm repos (declared as Release resources)
// ---------------------------------------------------------------------------

// ── Dapr ────────────────────────────────────────────────────────────────────
const daprNs = new k8s.core.v1.Namespace("dapr-system", {
  metadata: { name: "dapr-system" },
}, { provider: k8sProvider });

const dapr = new k8s.helm.v3.Release("dapr", {
  name:            "dapr",
  namespace:       daprNs.metadata.name,
  chart:           "dapr",
  repositoryOpts:  { repo: "https://dapr.github.io/helm-charts" },
  version:         "1.13.0",
  values: {
    global: {
      ha: { enabled: false },  // single-replica for demo cost
      logLevel: "info",
    },
    "dapr_placement": {
      replicaCount: 1,
    },
    "dapr_dashboard": {
      enabled: true,
    },
  },
}, { provider: k8sProvider, dependsOn: [daprNs] });

// Dapr component — Azure Service Bus pubsub
const daprSbComponent = new k8s.apiextensions.CustomResource("dapr-pubsub-sb", {
  apiVersion: "dapr.io/v1alpha1",
  kind:       "Component",
  metadata: {
    name:      "pubsub",
    namespace: "default",
    labels:    { "app.kubernetes.io/managed-by": "pulumi" },
  },
  spec: {
    type:    "pubsub.azure.servicebus.topics",
    version: "v1",
    metadata: [
      {
        name:      "connectionString",
        secretKeyRef: {
          name: "servicebus-secret",
          key:  "connectionString",
        },
      },
      { name: "maxConcurrentHandlers",  value: "32"    },
      { name: "minConnectionRecoveryInSec", value: "2" },
      { name: "maxConnectionRecoveryInSec", value: "300" },
    ],
    auth: { secretStore: "azure-keyvault" },
  },
}, { provider: k8sProvider, dependsOn: [dapr] });

// Dapr component — Azure Key Vault secret store
const daprKvComponent = new k8s.apiextensions.CustomResource("dapr-secretstore-kv", {
  apiVersion: "dapr.io/v1alpha1",
  kind:       "Component",
  metadata: { name: "azure-keyvault", namespace: "default" },
  spec: {
    type:    "secretstores.azure.keyvault",
    version: "v1",
    metadata: [
      { name: "vaultName", value: keyVaultUri.apply(u => String(u).split(".")[0].replace("https://", "")) },
      { name: "azureClientId", value: "WORKLOAD_IDENTITY_CLIENT_ID" }, // patched by Backstage template
    ],
  },
}, { provider: k8sProvider, dependsOn: [dapr] });

// Dapr resiliency policy — circuit breaker + retry for all services
const daprResiliency = new k8s.apiextensions.CustomResource("dapr-resiliency", {
  apiVersion: "dapr.io/v1alpha1",
  kind:       "Resiliency",
  metadata: { name: "microservices-resiliency", namespace: "default" },
  spec: {
    policies: {
      retries: {
        "retry-3x": {
          policy:   "constant",
          duration: "5s",
          maxRetries: 3,
        },
      },
      circuitBreakers: {
        "cb-shared": {
          maxRequests: 1,
          timeout:     "30s",
          trip:        "consecutiveFailures >= 5",
        },
      },
      timeouts: {
        "default-timeout": "30s",
      },
    },
    targets: {
      apps: Object.fromEntries(
        ["catalog", "ordering", "basket", "identity", "payment", "notification"].map(svc => [
          svc,
          { retry: "retry-3x", circuitBreaker: "cb-shared", timeout: "default-timeout" },
        ])
      ),
    },
  },
}, { provider: k8sProvider, dependsOn: [dapr] });

// ── KEDA ─────────────────────────────────────────────────────────────────────
const kedaNs = new k8s.core.v1.Namespace("keda", {
  metadata: { name: "keda" },
}, { provider: k8sProvider });

const keda = new k8s.helm.v3.Release("keda", {
  name:           "keda",
  namespace:      kedaNs.metadata.name,
  chart:          "keda",
  repositoryOpts: { repo: "https://kedacore.github.io/charts" },
  version:        "2.14.0",
  values: {
    metricsServer: { replicaCount: 1 },
    operator:      { replicaCount: 1 },
    resources: {
      operator: {
        requests: { cpu: "100m", memory: "128Mi" },
        limits:   { cpu: "500m", memory: "512Mi" },
      },
    },
  },
}, { provider: k8sProvider, dependsOn: [kedaNs] });

// KEDA ScaledObjects — one per service, one trigger per subscription it consumes.
//
// stage2.ts creates fan-out subscriptions named "{subscriber}-reads-{publisher}"
// on each "{publisher}-events" topic.  Each service consumes from every other
// service's topic, so a service with N peers has N triggers.  KEDA scales the
// deployment up when ANY trigger's message count exceeds the threshold.
const services = ["catalog", "ordering", "basket", "identity", "payment", "notification"];

const kedaScaledObjects = services.map(svc => {
  // The topics this service subscribes to are all topics published by other services.
  const publishers = services.filter(p => p !== svc);

  const triggers = publishers.map(publisher => ({
    type: "azure-servicebus",
    metadata: {
      topicName:              `${publisher}-events`,
      subscriptionName:       `${svc}-reads-${publisher}`,   // matches stage2.ts naming
      namespace:              serviceBusNs.apply(n => String(n)),
      messageCount:           "10",
      activationMessageCount: "1",
    },
    authenticationRef: { name: "keda-sb-auth" },
  }));

  return new k8s.apiextensions.CustomResource(`keda-so-${svc}`, {
    apiVersion: "keda.sh/v1alpha1",
    kind:       "ScaledObject",
    metadata: {
      name:      `${svc}-scaler`,
      namespace: svc,
    },
    spec: {
      scaleTargetRef: {
        apiVersion: "apps/v1",
        kind:       "Deployment",
        name:       svc,
      },
      pollingInterval:  15,
      cooldownPeriod:   60,
      minReplicaCount:  1,
      maxReplicaCount:  20,
      triggers,
    },
  }, { provider: k8sProvider, dependsOn: [keda] });
});

// TriggerAuthentication for KEDA → Service Bus via workload identity
const kedaTriggerAuth = new k8s.apiextensions.CustomResource("keda-sb-auth", {
  apiVersion: "keda.sh/v1alpha1",
  kind:       "ClusterTriggerAuthentication",
  metadata: { name: "keda-sb-auth" },
  spec: {
    podIdentity: {
      provider: "azure-workload",
    },
  },
}, { provider: k8sProvider, dependsOn: [keda] });

// ── Prometheus + Grafana (kube-prometheus-stack) ──────────────────────────────
const monNs = new k8s.core.v1.Namespace("monitoring", {
  metadata: { name: "monitoring" },
}, { provider: k8sProvider });

const promStack = new k8s.helm.v3.Release("kube-prometheus-stack", {
  name:           "kube-prometheus-stack",
  namespace:      monNs.metadata.name,
  chart:          "kube-prometheus-stack",
  repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
  version:        "58.6.0",
  values: {
    // Prometheus
    prometheus: {
      prometheusSpec: {
        retention:       "7d",
        storageSpec: {
          volumeClaimTemplate: {
            spec: {
              accessModes: ["ReadWriteOnce"],
              resources: { requests: { storage: "20Gi" } },
            },
          },
        },
        additionalScrapeConfigs: [
          // Dapr metrics endpoint
          {
            job_name: "dapr",
            kubernetes_sd_configs: [{ role: "pod" }],
            relabel_configs: [
              { source_labels: ["__meta_kubernetes_pod_annotation_dapr_io_enabled"], action: "keep", regex: "true" },
              { source_labels: ["__meta_kubernetes_pod_ip"], target_label: "__address__", replacement: "$1:9090" },
            ],
          },
        ],
      },
    },
    // Grafana
    grafana: {
      enabled: true,
      adminPassword: "demo-admin",  // override via KV in production
      dashboardProviders: {
        "dashboardproviders.yaml": {
          apiVersion: 1,
          providers: [{
            name:            "default",
            orgId:           1,
            folder:          "Microservices",
            type:            "file",
            disableDeletion: false,
            options:         { path: "/var/lib/grafana/dashboards/default" },
          }],
        },
      },
      dashboards: {
        default: {
          "dapr-system":  { gnetId: 17843, revision: 1, datasource: "Prometheus" },
          "keda-metrics": { gnetId: 14888, revision: 1, datasource: "Prometheus" },
        },
      },
      service: { type: "ClusterIP" },
    },
    // Alertmanager — minimal for demo
    alertmanager: { enabled: false },
    // Node exporter
    "prometheus-node-exporter": { enabled: true },
    // kube-state-metrics
    "kube-state-metrics": { enabled: true },
  },
}, { provider: k8sProvider, dependsOn: [monNs] });

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
export const daprVersion   = dapr.version;
export const kedaVersion   = keda.version;
export const promNamespace = monNs.metadata.name;
export const grafanaNote   = "kubectl port-forward -n monitoring svc/kube-prometheus-stack-grafana 3000:80";
