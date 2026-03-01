# Azure Microservices Demo Platform

A four-stage live demo platform that walks non-technical audiences through the evolution from a .NET monolith to a fully event-driven microservices architecture on Azure Kubernetes Service. Every stage builds on the last and can be demoed independently.

**Backstage is the single pane of glass.** The presenter never leaves it.

---

## Demo Narrative

| Stage | Architecture | Azure Services | The Point |
|---|---|---|---|
| **1** | ASP.NET monolith | App Service + shared SQL | Everything coupled; scale one thing, scale everything |
| **2** | 7 microservices on AKS | AKS, APIM, Service Bus, per-service DB | Kill the Ordering pod — Basket and Catalog keep running |
| **3** | Operational excellence | Dapr, KEDA, Prometheus/Grafana | KEDA scales pods from zero based on queue depth; distributed tracing |
| **4** | AI-driven platform | ArgoCD, OPA Gatekeeper, OTel, Claude Code | Push to Git → ArgoCD deploys; Backstage template + Claude Code scaffold a new service in minutes |

### The Killer Demo Moment (Stage 2)

```bash
# Open Backstage — show the dependency graph: 7 services, each connected only to its own database
# Then:
kubectl delete pod -l app=ordering -n ordering
# Basket and Catalog continue serving traffic through APIM.
# Service Bus has retained the lost events — Ordering replays them when it restarts.
```

---

## Repository Structure

```
azure-microservices-gitops/
├── infra/                    # Pulumi TypeScript IaC — deployed in stage order
│   ├── stage1.ts             # App Service + shared Azure SQL (monolith)
│   ├── stage2.ts             # AKS + APIM + Service Bus + per-service databases
│   ├── stage3.ts             # Dapr + KEDA + Prometheus/Grafana
│   ├── stage4.ts             # ArgoCD + OPA Gatekeeper + OpenTelemetry Operator
│   ├── Pulumi.yaml           # Project config — set main: to select stage
│   ├── package.json
│   └── tsconfig.json
├── helm/
│   ├── infrastructure/       # NGINX ingress, cert-manager, ArgoCD Image Updater
│   └── services/
│       └── catalog/          # Reference Helm chart — copy for each new service
├── argocd/
│   └── apps/                 # ArgoCD Application CRs (app-of-apps pattern)
│       ├── projects.yaml     # AppProjects: platform + microservices
│       ├── infrastructure.yaml
│       ├── monitoring.yaml
│       └── catalog.yaml      # Contains all 6 service Application CRs
├── backstage/
│   └── template.yaml         # Software Template for scaffolding new services
├── tests/
│   └── k6/smoke.js           # End-to-end load test: catalog → basket → order → notification
└── .github/workflows/
    └── ci.yaml               # Build · Scan · Push · Sync pipeline on AKS self-hosted runners
```

---

## Prerequisites

| Tool | Version | Purpose |
|---|---|---|
| [Pulumi CLI](https://www.pulumi.com/docs/install/) | ≥ 3.x | Infrastructure deployment |
| Node.js | ≥ 18 | Pulumi TypeScript runtime |
| Azure CLI | latest | `az login`, ACR auth |
| kubectl | ≥ 1.29 | Cluster access |
| Helm | ≥ 3.14 | Chart validation and local rendering |
| k6 | latest | Load testing |

**Azure permissions required:**
- Contributor on the target subscription (for Pulumi stages 1–2)
- `Microsoft.Authorization/roleAssignments/write` (for Workload Identity federation)

---

## How to Deploy

Follow this guide end-to-end before running any `pulumi up`. Each section maps to a blocking dependency for the stage that follows it.

### 1. Fork and clone

```bash
git clone --recurse-submodules https://github.com/YOUR_ORG/azure-microservices-gitops.git
cd azure-microservices-gitops
```

If you already cloned without submodules:
```bash
git submodule update --init --recursive
```

---

### 2. Azure — one-time setup

#### 2a. Create a Service Principal with OIDC federation (for GitHub Actions)

```bash
# Create an app registration
az ad app create --display-name "sp-gitops-ci"
APP_ID=$(az ad app list --display-name "sp-gitops-ci" --query "[0].appId" -o tsv)
SP_OBJ_ID=$(az ad sp create --id $APP_ID --query "id" -o tsv)

# Contributor on the subscription
az role assignment create \
  --assignee $APP_ID \
  --role Contributor \
  --scope /subscriptions/YOUR_SUBSCRIPTION_ID

# Federated credential so GitHub Actions can authenticate without a stored secret
az ad app federated-credential create --id $APP_ID --parameters '{
  "name": "github-oidc-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:YOUR_ORG/azure-microservices-gitops:ref:refs/heads/main",
  "audiences": ["api://AzureADUserImpersonation"]
}'

# Print the values you will need for GitHub secrets
echo "AZURE_CLIENT_ID:       $APP_ID"
echo "AZURE_TENANT_ID:       $(az account show --query tenantId -o tsv)"
echo "AZURE_SUBSCRIPTION_ID: $(az account show --query id -o tsv)"
```

#### 2b. Create a second App Registration for ArgoCD SSO *(Stage 4 only)*

```bash
az ad app create --display-name "app-argocd-sso" \
  --web-redirect-uris "https://argocd.YOUR_DOMAIN/auth/callback"
ARGOCD_APP_ID=$(az ad app list --display-name "app-argocd-sso" --query "[0].appId" -o tsv)
echo "argoCdClientId: $ARGOCD_APP_ID"
# Create a client secret and save it — you will store it as a Kubernetes secret after Stage 4
az ad app credential reset --id $ARGOCD_APP_ID
```

---

### 3. GitHub — secrets and variables

Go to **Settings → Secrets and variables → Actions** in your fork.

#### Secrets (sensitive — never logged)

| Secret | How to obtain |
|---|---|
| `AZURE_CLIENT_ID` | App registration client ID from step 2a |
| `AZURE_TENANT_ID` | `az account show --query tenantId -o tsv` |
| `AZURE_SUBSCRIPTION_ID` | `az account show --query id -o tsv` |
| `PULUMI_ACCESS_TOKEN` | [app.pulumi.com](https://app.pulumi.com) → your profile → Access Tokens |
| `GITOPS_PAT` | GitHub → Settings → Developer settings → PAT (classic), scopes: `repo` |
| `ARGOCD_AUTH_TOKEN` | Generated after Stage 4: `argocd account generate-token --account ci` |
| `APIM_GATEWAY_URL` | Pulumi stage2 output: `pulumi stack output apimGatewayUrl` |
| `APIM_SUBSCRIPTION_KEY` | Azure Portal → APIM → Subscriptions |
| `TEAMS_WEBHOOK_URI` | Teams channel → Connectors → Incoming Webhook |
| `BACKSTAGE_GITHUB_APP_ID` | GitHub App created for Backstage integration |
| `BACKSTAGE_GITHUB_PRIVATE_KEY` | Private key downloaded when creating the GitHub App |
| `AUTH_MICROSOFT_CLIENT_ID` | Entra App registration for Backstage SSO |
| `AUTH_MICROSOFT_CLIENT_SECRET` | Client secret for the above |
| `AUTH_MICROSOFT_TENANT_ID` | Same tenant ID as above |

#### Variables (non-sensitive — visible in logs)

Go to **Settings → Secrets and variables → Actions → Variables tab**.

| Variable | Value |
|---|---|
| `ACR_LOGIN_SERVER` | e.g. `acrstage2demo.azurecr.io` (stage2 output: `pulumi stack output acrLoginServer`) |
| `ARGOCD_SERVER` | e.g. `argocd.yourdomain.internal` — your ArgoCD ingress hostname |
| `GATEKEEPER_TEST_NS` | `gatekeeper-test` (default is fine) |

---

### 4. Pulumi — config variables per stage

All stages share a Pulumi stack per environment. Run these before `pulumi up` for each stage.

```bash
cd infra
npm install
az login
pulumi login   # or: export PULUMI_ACCESS_TOKEN=<token>
```

#### Stage 1

```bash
pulumi stack init stage1
pulumi config set location    uksouth          # Azure region
pulumi config set env         demo
```

#### Stage 2

```bash
pulumi stack init stage2
pulumi config set location       uksouth
pulumi config set env            demo
pulumi config set publisherEmail you@yourorg.com   # APIM publisher contact
pulumi config set publisherName  "Your Team Name"
# Optional overrides:
pulumi config set nodeVmSize  Standard_D4ds_v5
pulumi config set nodeCount   3
```

#### Stage 3

```bash
pulumi stack init stage3
pulumi config set pulumiOrg   YOUR_PULUMI_ORG   # your Pulumi Cloud organisation slug
pulumi config set env         demo
```

#### Stage 4

```bash
pulumi stack init stage4
pulumi config set pulumiOrg      YOUR_PULUMI_ORG
pulumi config set env            demo
pulumi config set gitOrg         YOUR_GITHUB_ORG
pulumi config set gitRepo        azure-microservices-gitops
pulumi config set tenantId       YOUR_ENTRA_TENANT_ID
pulumi config set argoCdClientId YOUR_ARGOCD_APP_CLIENT_ID
```

---

### 5. Deploy — stage by stage

#### Stage 1 (optional monolith demo)

```bash
# In infra/Pulumi.yaml, set:  main: stage1.ts
pulumi up --stack stage1
```

#### Stage 2 — AKS platform (required for all later stages)

```bash
# Set main: stage2.ts in Pulumi.yaml
pulumi up --stack stage2

# Save cluster credentials
az aks get-credentials \
  --resource-group rg-microservices-stage2-demo \
  --name aks-stage2-demo
```

#### Install Actions Runner Controller (ARC) on AKS

The CI pipeline requires self-hosted runners on AKS. Install ARC after Stage 2:

```bash
# Install the controller
helm install arc \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set-controller \
  --namespace arc-systems --create-namespace

# Install a runner scale set (replace ORG and PAT)
helm install arc-runners \
  oci://ghcr.io/actions/actions-runner-controller-charts/gha-runner-scale-set \
  --namespace arc-runners --create-namespace \
  --set githubConfigUrl="https://github.com/YOUR_ORG/azure-microservices-gitops" \
  --set githubConfigSecret.github_token="YOUR_GITOPS_PAT"
```

#### Stage 3 — Dapr, KEDA, Prometheus

```bash
# Set main: stage3.ts
pulumi up --stack stage3
```

#### Stage 4 — ArgoCD, Gatekeeper, OTel

```bash
# Set main: stage4.ts
pulumi up --stack stage4
```

Stage 4 bootstraps ArgoCD and applies the app-of-apps manifest automatically. After it completes, ArgoCD takes ownership of all Helm releases in `argocd/apps/`.

#### Store ArgoCD SSO client secret

```bash
kubectl create secret generic argocd-azure-secret \
  --from-literal=oidc.azure.clientSecret=YOUR_ARGOCD_CLIENT_SECRET \
  -n argocd
```

#### Create a CI service account token for ArgoCD

```bash
# Add a CI account to ArgoCD, generate a token, then save it as the ARGOCD_AUTH_TOKEN GitHub secret
argocd account generate-token --account ci
```

---

### 6. Set your Entra tenant ID in the ArgoCD app manifests

Before ArgoCD can sync the Helm charts, the CSI Secrets Store driver needs your Entra tenant ID to connect to Key Vault. Edit `argocd/apps/catalog.yaml` and replace the six empty `azure.tenantId` parameters with your actual tenant ID:

```bash
TENANT_ID=$(az account show --query tenantId -o tsv)

# Update all six service Application manifests in one go
sed -i "s|value: \"\"   # REQUIRED — replace with your Entra tenant ID.*|value: \"${TENANT_ID}\"|g" \
  argocd/apps/catalog.yaml

git add argocd/apps/catalog.yaml
git commit -m "chore: set azure.tenantId for demo environment"
git push
```

ArgoCD will pick up the change within 3 minutes and re-render the Helm charts with the correct tenant ID.

---

### 7. Pin npm dependencies (reproducible Pulumi builds)

The `infra/package.json` uses caret ranges (`^3`, `^2`). Pin exact versions by committing the lock file:

```bash
cd infra
npm install
git add package-lock.json
git commit -m "chore: commit package-lock.json for reproducible Pulumi builds"
git push
```

---

### 8. Validate

```bash
# All ArgoCD apps should be Healthy + Synced
argocd app list

# Smoke test through APIM (requires Stage 2+)
k6 run \
  --env APIM_GATEWAY=$(pulumi stack output apimGatewayUrl --stack stage2) \
  --env APIM_KEY=YOUR_SUBSCRIPTION_KEY \
  tests/k6/smoke.js
```

---

## Deployment

### Stage 1 — Monolith Foundation

```bash
cd infra
npm install

# Authenticate
az login
pulumi login   # or PULUMI_ACCESS_TOKEN env var

pulumi stack init stage1
pulumi config set location uksouth   # or your preferred region
pulumi config set env demo

# Pulumi.yaml already points to stage1.ts
pulumi up
```

**What gets created:** Resource group `rg-microservices-stage1-demo`, App Service Plan (B2), App Service with System Assigned Managed Identity, Azure SQL Server (Entra ID–only auth, no SQL password), monolith database.

**Key outputs:**
```
appUrl           → https://app-monolith-stage1-demo.azurewebsites.net
sqlServerFqdn    → sql-monolith-stage1-demo.database.windows.net
```

---

### Stage 2 — AKS Microservices Platform

```bash
# Update Pulumi.yaml: change  main: stage1.ts  →  main: stage2.ts
pulumi stack init stage2
pulumi up
```

**What gets created:**
- AKS 1.29 (Cilium CNI, Workload Identity, OIDC issuer)
- Azure Container Registry
- Service Bus (per-service topics with fan-out subscriptions)
- Cosmos DB serverless — catalog, basket
- Azure SQL serverless — ordering, payment
- Azure Key Vault (RBAC, private endpoint)
- API Management (Developer tier, external VNet)
- Private endpoints for all data services

**Get cluster credentials:**
```bash
az aks get-credentials \
  --resource-group rg-microservices-stage2-demo \
  --name aks-stage2-demo
```

---

### Stage 3 — Observability & Autoscaling

```bash
# Update Pulumi.yaml: main: stage3.ts
pulumi stack init stage3
pulumi up
```

**What gets created (via Helm on AKS):**
- Dapr 1.13.0 — pub/sub via Service Bus, secrets via Key Vault, resiliency policies
- KEDA 2.14.0 — ScaledObjects per service (1–20 pods, triggers on Service Bus message count)
- kube-prometheus-stack 58.6.0 — Prometheus (7-day retention), Grafana with pre-built Dapr/KEDA dashboards

**Access dashboards:**
```bash
# Grafana
kubectl port-forward svc/kube-prometheus-stack-grafana 3000:80 -n monitoring

# Dapr dashboard
kubectl port-forward svc/dapr-dashboard 8080:8080 -n dapr-system
```

---

### Stage 4 — GitOps & Policy

```bash
# Update Pulumi.yaml: main: stage4.ts
pulumi stack init stage4

# Required config
pulumi config set tenantId     <your-entra-tenant-id>
pulumi config set gitOpsRepo   https://github.com/YOUR_ORG/azure-microservices-gitops

pulumi up
```

**What gets created:**
- ArgoCD 6.11.1 — app-of-apps bootstrap watching `argocd/apps/`
- OPA Gatekeeper 3.17.1 — enforces resource limits and blocks `:latest` image tags
- OpenTelemetry Operator 0.61.0 — auto-instrumentation for .NET and Node.js

**Access ArgoCD:**
```bash
kubectl port-forward svc/argocd-server 8080:443 -n argocd
# Retrieve initial admin password:
kubectl get secret argocd-initial-admin-secret -n argocd \
  -o jsonpath='{.data.password}' | base64 -d
```

---

## GitOps Deployment Flow (Post Stage 4)

Once ArgoCD is running, the repo drives all deployments:

```
Developer pushes to main
        ↓
GitHub Actions (ci.yaml)
  ├── Detects which services changed
  ├── Builds distroless Docker image
  ├── Scans with Trivy (fails on CRITICAL CVEs)
  ├── Runs dotnet test inside the image
  ├── Helm lint + Gatekeeper dry-run validation
  ├── Pushes semver-tagged image to ACR
  └── ArgoCD Image Updater commits new tag to helm/services/<svc>/Chart.yaml
          ↓
ArgoCD detects the commit → syncs the Helm chart → rolls out new pods
          ↓
KEDA scales pods 1–20 based on Service Bus queue depth
```

**ArgoCD sync waves** (deploy order):
1. Wave -2: NGINX ingress, cert-manager (cluster-wide infra)
2. Wave -1: Identity, Monitoring
3. Wave 0: Catalog, Ordering, Basket, Payment
4. Wave 1: Notification

---

## Helm Charts

### Validating Charts

```bash
helm lint helm/infrastructure/
helm lint helm/services/catalog/

# Render templates locally (inspect output before deploying)
helm template release helm/services/catalog/ -f helm/services/catalog/values.yaml
```

### Adding a New Service

The `catalog` chart is the reference implementation. To add a new service:

1. **Copy the chart:**
   ```bash
   cp -r helm/services/catalog helm/services/<new-service>
   ```
2. **Edit `helm/services/<new-service>/Chart.yaml`** — update `name` and `appVersion`
3. **Edit `helm/services/<new-service>/values.yaml`** — update image name, Dapr app-id, database config
4. **Create `argocd/apps/<new-service>.yaml`** — use any existing service Application CR as a template
5. *(Optional)* Update `infra/stage2.ts` to provision the database, Service Bus topics, and APIM API

ArgoCD will auto-sync the new chart within 3 minutes of the commit landing on `main`.

Alternatively, use the **Backstage Software Template** (`backstage/template.yaml`) to scaffold all of the above through a web form in the Backstage UI — including Workload Identity federation, Key Vault access, and Service Bus topic creation.

---

## Running Load Tests

```bash
# Smoke test — 10s, 2 VUs (used as CI gate)
k6 run --env SCENARIO=smoke \
       --env APIM_GATEWAY=https://apim-stage2-demo.azure-api.net \
       --env APIM_KEY=<subscription-key> \
       tests/k6/smoke.js

# Load test — 5 min ramp to 20 VUs (triggers KEDA scale-out)
k6 run --env SCENARIO=load tests/k6/smoke.js

# Soak test — 30 min, 5 VUs
k6 run --env SCENARIO=soak tests/k6/smoke.js
```

The test covers the full order flow: browse catalog → add to basket → submit order → poll notification for `OrderPlaced` event.

---

## Required GitHub Secrets

Set these in the repo's **Settings → Secrets and variables → Actions**:

| Secret | Description |
|---|---|
| `AZURE_CLIENT_ID` | Federated credential client ID (for OIDC — no stored password) |
| `AZURE_TENANT_ID` | Entra ID tenant ID |
| `AZURE_SUBSCRIPTION_ID` | Target Azure subscription |
| `PULUMI_ACCESS_TOKEN` | Pulumi Cloud token |
| `ARGOCD_AUTH_TOKEN` | ArgoCD API token (CI uses this to trigger syncs) |
| `APIM_GATEWAY_URL` | APIM gateway URL for smoke tests |
| `APIM_SUBSCRIPTION_KEY` | APIM subscription key for smoke tests |
| `GITOPS_PAT` | GitHub PAT — CI uses this to commit image tag bumps |
| `TEAMS_WEBHOOK_URI` | Incoming webhook for build failure notifications |
| `BACKSTAGE_GITHUB_APP_ID` | GitHub App ID for Backstage integration |
| `BACKSTAGE_GITHUB_PRIVATE_KEY` | GitHub App private key |
| `AUTH_MICROSOFT_CLIENT_ID` | Entra App registration for Backstage SSO |
| `AUTH_MICROSOFT_CLIENT_SECRET` | Entra App registration secret |
| `AUTH_MICROSOFT_TENANT_ID` | Entra tenant for Backstage SSO |

---

## Source Application Repositories

This GitOps repo is the **platform layer** — it defines how services are deployed, scaled, and observed. The application source code is included as **git submodules** under `src/`:

| Path | Repo | Stage |
|---|---|---|
| `src/monolith` | [eShopModernizing](https://github.com/dotnet-architecture/eShopModernizing) | Stage 1 — ASP.NET monolith on App Service |
| `src/eshop-on-dapr` | [eShopOnDapr](https://github.com/dotnet-architecture/eShopOnDapr) | Stages 2–3 — .NET 8 microservices on Dapr |

**Clone with submodules:**

```bash
git clone --recurse-submodules https://github.com/bend72/azure-microservices-gitops.git

# Already cloned without submodules?
git submodule update --init --recursive
```

**eShopOnDapr service → platform namespace mapping:**

| Submodule path | Platform namespace | Data store |
|---|---|---|
| `src/eshop-on-dapr/src/Services/Catalog.API` | `catalog` | Cosmos DB |
| `src/eshop-on-dapr/src/Services/Basket.API` | `basket` | Cosmos DB |
| `src/eshop-on-dapr/src/Services/Ordering.API` | `ordering` | Azure SQL |
| `src/eshop-on-dapr/src/Services/Payment.API` | `payment` | Azure SQL |
| `src/eshop-on-dapr/src/Services/Identity.API` | `identity` | Stateless |
| `src/eshop-on-dapr/src/Services/Webhooks.API` | `notification` | Stateless |

> **CI note:** The workflow resolves each service name to its full submodule path (e.g. `catalog` → `src/eshop-on-dapr/src/Services/Catalog.API`) before running Docker build. No symlinks or manual path edits are required.

---

## Current Status

| Component | Status | Notes |
|---|---|---|
| `infra/stage1.ts` | ✅ Complete | App Service + SQL monolith; APIM publisher configurable via Pulumi config |
| `infra/stage2.ts` | ✅ Complete | AKS + all data services; Service Bus Standard tier (cost-optimised) |
| `infra/stage3.ts` | ✅ Complete | Dapr, KEDA, Prometheus; Pulumi org read from `pulumiOrg` config |
| `infra/stage4.ts` | ✅ Complete | ArgoCD, Gatekeeper, OTel; SSO tenant/clientId read from config |
| `infra/package.json` | ⚠️ Action needed | Commit `package-lock.json` after `npm install` for reproducible builds |
| `helm/infrastructure` | ✅ Complete | NGINX, cert-manager, ArgoCD Image Updater |
| `helm/services/catalog` | ✅ Complete | Reference chart; serviceaccount, instrumentation templates added |
| `helm/services/{ordering,basket,payment,identity,notification}` | ✅ Complete | All 5 charts; serviceaccount + OTel instrumentation templates added |
| `helm/services/*/values.yaml` | ✅ Complete | `azure.keyVaultName` + `azure.tenantId` fields; `otel.createInstrumentation` |
| `helm/services/*/values-demo.yaml` | ⚠️ Action needed | Set `azure.tenantId` before deploying (see How to Deploy step 6) |
| `helm/monitoring` | ✅ Complete | kube-prometheus-stack 58.6.0 umbrella chart for ArgoCD |
| `backstage/skeleton` | ✅ Complete | Helm chart + ArgoCD app + catalog-info Nunjucks templates |
| `argocd/apps/catalog.yaml` | ⚠️ Action needed | Set `azure.tenantId` parameter for all 6 service apps (see step 6) |
| `argocd/apps/{infrastructure,monitoring,projects}.yaml` | ✅ Complete | Repo URL set to `bend72/azure-microservices-gitops` |
| `src/` (microservice code) | ⬜ Submodules | Populate with `git submodule update --init --recursive` |
| `.github/workflows/ci.yaml` | ✅ Complete | Builds from eShopOnDapr submodule paths; ACR/ArgoCD URLs via GitHub vars |
| `tests/k6/smoke.js` | ✅ Complete | Smoke/load/soak scenarios; requires Stage 2+ running |

---

## Known Issues

- **Prometheus ownership:** Stage 3 Pulumi and the `helm/monitoring` ArgoCD chart both manage kube-prometheus-stack. When migrating to Stage 4, run `pulumi state delete` on the `kube-prometheus-stack` resource in the stage3 stack before letting ArgoCD apply `helm/monitoring`.
- **Grafana password:** `grafana.adminPassword` is set to `demo-admin` in `helm/monitoring/values.yaml`. Store the real password in Key Vault and inject it via a Kubernetes Secret for production use.
- **Tenant ID:** `azure.tenantId` is intentionally left empty in all `values-demo.yaml` and `argocd/apps/catalog.yaml` — it must be set to your Entra tenant ID before Stage 4 deployment (see How to Deploy step 6).
