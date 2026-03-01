# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Purpose

This is a **GitOps infrastructure-as-code repository** for a multi-stage Azure Kubernetes Service (AKS) microservices platform. It is **not an application codebase** — there are no application build steps. Changes here are deployed automatically via ArgoCD when pushed to `main`.

## Infrastructure Provisioning (Pulumi)

The `infra/` directory contains TypeScript Pulumi programs deployed in stages:

```bash
# Run from infra/ directory with appropriate Pulumi stack selected
pulumi preview        # Dry-run to see planned changes
pulumi up             # Apply changes to Azure
pulumi destroy        # Tear down resources
```

- **stage2.ts** — Azure foundation: Resource Group, VNet, AKS (Cilium CNI), ACR, Service Bus, Cosmos DB, Azure SQL, Key Vault, APIM, private endpoints
- **stage3.ts** — Cluster components: Dapr 1.13.0, KEDA 2.14.0, Prometheus/Grafana (kube-prometheus-stack 58.6.0)
- **stage4.ts** — GitOps governance: ArgoCD 6.11.1, OPA Gatekeeper 3.17.1, OpenTelemetry Operator 0.61.0

## Helm Chart Validation

```bash
helm lint helm/infrastructure/
helm lint helm/services/catalog/

# Render templates locally to inspect output
helm template my-release helm/services/catalog/ -f helm/services/catalog/values.yaml
helm template my-release helm/infrastructure/ -f helm/infrastructure/values.yaml
```

## Performance Testing

```bash
# k6 smoke test (once implemented)
k6 run tests/k6/smoke.js
```

## Architecture Overview

### GitOps Flow

1. Push Helm chart changes to `helm/services/<service>/` or `helm/infrastructure/`
2. ArgoCD detects the commit and syncs automatically (self-healing, pruning enabled)
3. ArgoCD Image Updater watches ACR (`acrstage2demo.azurecr.io`) for new semver tags and commits them to `main`
4. KEDA autoscales pods (1–20 replicas) based on Azure Service Bus message count (threshold: 10)

### ArgoCD App-of-Apps Pattern

`argocd/apps/` contains ArgoCD `Application` CRs. The root `app-of-apps` Application watches this directory and manages all deployments.

**Sync waves** (order of deployment):
- Wave -2: Infrastructure (NGINX ingress, cert-manager)
- Wave -1: Identity, Monitoring
- Wave 0: Catalog, Ordering, Basket, Payment
- Wave 1: Notification

**Projects** (RBAC isolation):
- `platform` — cluster-wide infra; `platform-admins` group only
- `microservices` — namespace-scoped services; `dev-team` group gets sync rights

### Adding a New Microservice

When adding a new service (e.g., `myservice`), you need changes in three places:

1. **`helm/services/myservice/`** — Copy and adapt from `helm/services/catalog/`. Key templates: `deployment.yaml`, `service.yaml`, `ingress.yaml`, `secretproviderclass.yaml`, `pdb.yaml`
2. **`argocd/apps/myservice.yaml`** — ArgoCD Application CR pointing to `helm/services/myservice`, with Image Updater annotations and appropriate sync wave
3. **`infra/stage2.ts`** — Add namespace, Service Bus topic/subscriptions, data store, Key Vault secrets, APIM API, private endpoints as needed

### Key Conventions

- **Workload Identity**: All pods use `azure.workload.identity/use: "true"` label. Never use static credentials.
- **Secrets**: Injected via Azure CSI Secrets Store (Key Vault). Secrets are mounted as env vars. The `SecretProviderClass` template maps KV secret names to Kubernetes secret keys.
- **Dapr**: All services use Dapr sidecar for pub/sub (Service Bus) and secret access. The init container (`busybox`) waits for the Dapr sidecar on port 3500 before the main app starts.
- **OPA Gatekeeper policies**: CPU/memory requests+limits are required on all pods. `:latest` image tags are denied. Do not remove resource requests/limits from Helm values.
- **Replica counts**: Do not set `replicas` > 1 in Helm values — KEDA owns replica counts at runtime. ArgoCD is configured to ignore replica count drift for microservice apps.
- **Image tagging**: Never use `:latest`. ArgoCD Image Updater requires semver tags (e.g., `0.1.0`).
- **cert-manager / TLS**: DNS-01 ACME challenge via Azure DNS with workload identity. `ClusterIssuer` template is in `helm/infrastructure/templates/clusterissuer.yaml`.

### Key Resource Identifiers

| Resource | Value |
|---|---|
| ACR | `acrstage2demo.azurecr.io` |
| Resource Group | `rg-microservices-stage2-demo` |
| AKS version | 1.29, Cilium CNI |
| Azure region | `uksouth` (configurable) |
| Internal DNS zone | `contoso-demo.internal` |
| Service Bus retention | 14 days |
| Cosmos DB | Serverless (catalog, basket) |
| Azure SQL | General Purpose, auto-pause 60min (ordering, payment) |
