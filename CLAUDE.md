# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Goal

Build a four-stage live demo platform showing the evolution from monolith to microservices. The audience is non-engineers; the demo must be visual and immediate. **Backstage is the single pane of glass** — the presenter never leaves it.

| Stage | Architecture | Key Demo Point |
|---|---|---|
| 1 | ASP.NET Monolith on App Service + shared SQL | Tight coupling, shared schema, single point of failure |
| 2 | 7 Microservices on AKS + APIM + Service Bus | Kill one pod, others keep running; each service owns its DB |
| 3 | Dapr, KEDA, Prometheus | Autoscaling, observability, failure injection |
| 4 | ArgoCD, OPA Gatekeeper, OpenTelemetry + **Claude Code as pipeline actor** | AI-driven platform via Backstage Software Template |

**Killer demo moment (Stage 2):** Backstage dependency graph shows 7 services each connected to their own database node. Then `kubectl delete pod -l app=ordering` — Basket and Catalog keep serving traffic; Service Bus retains the lost events for replay.

**Meta-demo (Stage 4):** The Backstage Software Template invokes Claude Code via MCP to scaffold new services — AI driving the platform.

## Infrastructure Provisioning (Pulumi)

The `infra/` directory contains TypeScript Pulumi programs. Each stage is an independent entry point:

```bash
cd infra
npm install

# Stage 1 — monolith foundation (update Pulumi.yaml main: stage1.ts)
pulumi stack init stage1
pulumi up

# Stage 2 — AKS microservices (update Pulumi.yaml main: stage2.ts)
pulumi stack init stage2
pulumi up

# Stages 3 & 4 follow the same pattern
pulumi preview          # dry-run
pulumi destroy          # tear down
```

To switch which stage runs, change the `main` field in `infra/Pulumi.yaml` to `stage1.ts`, `stage2.ts`, etc., or update `Pulumi.<stack>.yaml` with a per-stack override.

## Helm Chart Validation

```bash
helm lint helm/infrastructure/
helm lint helm/services/catalog/

# Render templates locally
helm template release helm/services/catalog/ -f helm/services/catalog/values.yaml
helm template release helm/infrastructure/ -f helm/infrastructure/values.yaml
```

## Performance Testing

```bash
k6 run tests/k6/smoke.js
```

## Architecture Overview

### Repository Layout

```
infra/            Pulumi TypeScript — stage1.ts through stage4.ts
helm/
  infrastructure/ NGINX ingress, cert-manager, ArgoCD Image Updater
  services/       Per-service Helm charts (catalog is the reference)
argocd/apps/      ArgoCD Application CRs (app-of-apps pattern)
backstage/        Backstage IDP config + Dockerfile (to be built out)
services/         The 7 microservice application codebases (to be added)
tests/k6/         k6 smoke tests
```

### GitOps Flow (Stages 3–4)

1. Push Helm chart changes to `helm/services/<service>/`
2. ArgoCD detects the commit and syncs automatically
3. ArgoCD Image Updater watches `acrstage2demo.azurecr.io` for new semver tags and commits them to `main`
4. KEDA autoscales pods (1–20) based on Azure Service Bus message count (threshold: 10)

### ArgoCD App-of-Apps

`argocd/apps/` contains ArgoCD `Application` CRs. Sync wave order:
- Wave -2: Infrastructure (NGINX, cert-manager)
- Wave -1: Identity, Monitoring
- Wave 0: Catalog, Ordering, Basket, Payment
- Wave 1: Notification

RBAC projects: `platform` (cluster-wide, platform-admins only) and `microservices` (namespace-scoped, dev-team).

### Adding a New Microservice

Three files needed:
1. `helm/services/<name>/` — copy from `helm/services/catalog/`
2. `argocd/apps/<name>.yaml` — ArgoCD Application CR with Image Updater annotations and sync wave
3. `infra/stage2.ts` — namespace, Service Bus topic/subscriptions, data store, Key Vault secrets, APIM API

### Key Conventions

- **Workload Identity:** All pods use `azure.workload.identity/use: "true"`. App Services use System Assigned Managed Identity. No stored credentials anywhere.
- **Secrets:** Azure CSI Secrets Store syncs Key Vault secrets into pod env vars via `SecretProviderClass`.
- **Dapr:** All microservices use Dapr sidecar for pub/sub (Service Bus) and secret access. Init container waits for Dapr on port 3500.
- **OPA Gatekeeper:** CPU/memory requests+limits required on all pods. `:latest` image tags denied.
- **Replica counts:** KEDA owns replica counts at runtime. Do not set `replicas > 1` in Helm values. ArgoCD ignores replica drift.
- **Image tagging:** Semver only (e.g., `0.1.0`). ArgoCD Image Updater requires it.

### Key Resource Identifiers

| Resource | Value |
|---|---|
| ACR | `acrstage2demo.azurecr.io` |
| Stage 1 RG | `rg-microservices-stage1-<env>` |
| Stage 2 RG | `rg-microservices-stage2-<env>` |
| AKS version | 1.29, Cilium CNI |
| Azure region | `uksouth` (configurable via `location` config) |
| Internal DNS zone | `contoso-demo.internal` |
| Service Bus retention | 14 days |
| Stage 2 data stores | Cosmos DB serverless (catalog, basket) + Azure SQL auto-pause (ordering, payment) |

### GitHub Actions Secrets Required

```
AZURE_CLIENT_ID          # Federated credential client ID
AZURE_TENANT_ID
AZURE_SUBSCRIPTION_ID
PULUMI_ACCESS_TOKEN
BACKSTAGE_GITHUB_APP_ID
BACKSTAGE_GITHUB_PRIVATE_KEY
AUTH_MICROSOFT_CLIENT_ID
AUTH_MICROSOFT_CLIENT_SECRET
AUTH_MICROSOFT_TENANT_ID
```
