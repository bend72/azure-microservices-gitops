# Claude Code Handoff: Azure Microservices Demo Platform

## Project Goal
Build a working demo platform that visually and interactively shows colleagues the tangible benefits of microservices over a monolithic architecture. The audience is non-engineers, so the "wow moment" must be visual, immediate, and self-explanatory.

---

## The Core Demo Narrative (Four Stages)

| Stage | Architecture | Azure Services | Key Demo Point |
|---|---|---|---|
| 1 | ASP.NET Monolith | App Service, single SQL DB | Tight coupling, shared schema, single point of failure |
| 2 | 7 Microservices on AKS | AKS, APIM, Service Bus, per-service PostgreSQL | Each service owns its data; kill one, others keep running |
| 3 | Operational Excellence | Dapr, KEDA, Prometheus, distributed tracing | Observability, autoscaling, failure injection |
| 4 | Serverless / Event-driven | Azure Functions, Event Grid, SignalR | Real-time reactive architecture, near-zero ops overhead |

The **killer demo moment** is Stage 2: showing the Backstage relationship graph where each microservice connects to only its own database — then live-killing the Ordering service pod while Basket and Catalog continue serving traffic, with Service Bus retaining events for replay.

---

## Architecture Overview

### Single Monorepo Structure
```
azure-microservices-demo/
├── infra/                    # Pulumi TypeScript IaC
│   ├── stage1.ts             # App Service + shared SQL
│   ├── stage2.ts             # AKS + APIM + Service Bus + per-service DBs  ← most complex
│   ├── stage3.ts             # Dapr + KEDA + Prometheus
│   ├── stage4.ts             # ArgoCD + OPA Gatekeeper + OpenTelemetry
│   └── Pulumi.yaml
├── backstage/                # Backstage IDP
│   ├── app-config.yaml       # Microsoft Entra ID auth, GitHub integration
│   ├── packages/
│   │   ├── app/src/
│   │   │   ├── App.tsx       # All plugin registrations
│   │   │   └── components/catalog/EntityPage.tsx
│   │   └── backend/src/
│   │       └── index.ts      # New backend system
│   └── Dockerfile            # Multi-stage with all tooling
├── services/                 # The 7 microservices
│   ├── basket/
│   ├── catalog/
│   ├── ordering/
│   ├── payment/
│   ├── identity/
│   ├── notification/
│   └── shipping/
├── helm/                     # Helm charts
│   ├── infrastructure/       # Shared infra chart
│   └── microservices/        # Per-service chart template
├── gitops/                   # ArgoCD manifests
│   ├── app-of-apps.yaml
│   └── apps/
├── .github/workflows/        # GitHub Actions (runs on ARC self-hosted runners in AKS)
└── tests/
    └── smoke/                # k6 end-to-end tests
```

---

## What Has Already Been Designed / Generated

The following files have been fully specified in prior conversations and need to be created on disk:

### Infrastructure (Pulumi TypeScript)
- **`infra/stage1.ts`** — App Service plan, Azure SQL, basic networking
- **`infra/stage2.ts`** — AKS workload cluster, APIM, Service Bus (Standard tier), 7× PostgreSQL Flexible Server instances, Redis cache, Azure Container Registry, Key Vault with RBAC, Workload Identity (OIDC) federation, per-service managed identities. **This is the most complex file — all resources must use `dependsOn` correctly and Workload Identity must be wired to each service's Kubernetes ServiceAccount.**
- **`infra/stage3.ts`** — Dapr extension on AKS, KEDA, Prometheus/Grafana via Helm, alerting rules
- **`infra/stage4.ts`** — ArgoCD, OPA Gatekeeper policies, OpenTelemetry Collector, cert-manager

### Backstage
- **`backstage/app-config.yaml`** — Auth via Microsoft Entra ID (MSAL), GitHub integration for scaffolder/TechDocs, PostgreSQL backend catalog, Azure Blob Storage for TechDocs static site
- **`backstage/packages/app/src/App.tsx`** — Plugins: catalog, scaffolder, techdocs, kubernetes, cost-insights, github-actions, search
- **`backstage/packages/backend/src/index.ts`** — New backend system with catalog, auth, scaffolder, techdocs, kubernetes, search processors
- **`backstage/packages/app/src/components/catalog/EntityPage.tsx`** — Custom tabs showing: Overview, Kubernetes pods, GitHub Actions runs, API docs, Dependencies graph, Cost
- **`backstage/Dockerfile`** — Multi-stage distroless image with Node 20, Pulumi CLI, kubectl, helm, argocd CLI

### GitOps & Helm
- **`gitops/app-of-apps.yaml`** — ArgoCD App-of-Apps pointing to `helm/` directory
- **`helm/microservices/`** — Parameterised Helm chart reused per service (image, replicas, env, serviceAccountName, ingress annotations for APIM)
- **Backstage Software Template** — `template.yaml` that scaffolds a new microservice repo, registers it in the catalog, creates GitHub repo, triggers initial CI/CD run, all via Claude Code agent steps

### Services
- **Distroless Dockerfile** — Multi-stage build (build → test → distroless runtime) for each service
- **k6 smoke tests** — End-to-end tests hitting APIM gateway, asserting p95 < 500ms

---

## Key Technical Decisions to Preserve

1. **No stored secrets anywhere.** All Azure auth uses Workload Identity (OIDC federation). GitHub Actions uses `azure/login@v2` with federated credentials. Pods use `azure.workload.identity/use: "true"` label.

2. **Pulumi TypeScript, not Bicep or Terraform.** The IaC runs as part of the GitHub Actions pipeline. There is a comment in `stage2.ts` noting that `aztfexport` can convert to Terraform HCL for teams that prefer it.

3. **Backstage is the single pane of glass** — the demo presenter never leaves Backstage. Everything (deploy, observe, chaos, cost) is surfaced through plugins.

4. **Claude Code is an actor in the pipeline.** The Backstage Software Template invokes Claude Code (via MCP) to: generate service boilerplate, write the `catalog-info.yaml`, create the GitHub Actions workflow, and draft the initial TechDocs page. This is a meta-demo point — AI driving the platform.

5. **ARC (Actions Runner Controller) self-hosted runners** run inside the AKS cluster so GitHub Actions workflows have direct `kubectl` access without exposing the API server publicly.

6. **Single monorepo** — decided against two-repo split. Simpler for a single-team demo.

---

## What Needs To Be Built Next (Priority Order)

### Phase 1 — Foundation (do this first)
1. Create the monorepo folder structure above
2. Write `infra/stage1.ts` and deploy Stage 1 to Azure (validates Pulumi + Azure auth works)
3. Deploy Backstage with just the catalog plugin pointing at the monorepo — confirm you can see `catalog-info.yaml` entities

### Phase 2 — The Core Demo
4. Write and deploy `infra/stage2.ts` — AKS + all 7 microservices infrastructure
5. Write placeholder microservices (can be simple HTTP echo servers initially) with correct `catalog-info.yaml` relationship metadata
6. Confirm the **Backstage dependency graph** shows 7 services each with their own database node
7. Script the **chaos demo**: `kubectl delete pod -l app=ordering` and show Basket/Catalog still respond via APIM

### Phase 3 — Operational Story
8. Deploy `infra/stage3.ts` — Dapr, KEDA, Prometheus
9. Wire Grafana dashboard URL into Backstage Cost Insights / custom iframe card
10. Add k6 smoke test to CI so it runs after each deployment

### Phase 4 — The AI Story
11. Complete the Backstage Software Template with Claude Code MCP steps
12. Deploy `infra/stage4.ts` — ArgoCD, OPA, OpenTelemetry
13. Record walkthrough video of the full 4-stage narrative

---

## Environment Variables / Secrets Needed
These go into GitHub repo secrets and are fed to Pulumi via environment:

```
AZURE_CLIENT_ID          # Federated credential client ID
AZURE_TENANT_ID          # Entra ID tenant
AZURE_SUBSCRIPTION_ID    # Target subscription
PULUMI_ACCESS_TOKEN      # Pulumi Cloud token
GITHUB_TOKEN             # Auto-provided by Actions
BACKSTAGE_GITHUB_APP_ID  # GitHub App for Backstage integration
BACKSTAGE_GITHUB_PRIVATE_KEY
AUTH_MICROSOFT_CLIENT_ID # Entra App reg for Backstage login
AUTH_MICROSOFT_CLIENT_SECRET
AUTH_MICROSOFT_TENANT_ID
```

---

## Suggested Starting Prompt for Claude Code

```
I'm building an Azure microservices demo platform in a monorepo. 
The goal is a four-stage demo: Monolith → Microservices → Operational Excellence → Serverless.
The platform uses Backstage.io as the IDP, Pulumi TypeScript for IaC, AKS, and GitHub Actions with ARC self-hosted runners.

Please start by:
1. Scaffolding the full monorepo folder structure (create all directories and placeholder README.md files)
2. Writing infra/stage1.ts — Pulumi TypeScript that deploys an Azure App Service Plan (B2), a single Azure SQL database, and an App Service to host the eShopModernizing monolith. Use Workload Identity, no stored credentials.
3. Writing the root Pulumi.yaml and package.json for the infra/ directory

Key constraints:
- No stored secrets; use Workload Identity / OIDC federation everywhere
- All resources tagged with: environment, project="microservices-demo", stage
- Use @pulumi/azure-native (not the classic provider)
- TypeScript strict mode
```
