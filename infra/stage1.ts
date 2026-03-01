import * as pulumi from "@pulumi/pulumi";
import * as azure_native from "@pulumi/azure-native";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const cfg      = new pulumi.Config();
const location = cfg.get("location") ?? "uksouth";
const env      = cfg.get("env")      ?? "demo";

const tags = {
  stage:   "1",
  env,
  project: "microservices-demo",
};

// ---------------------------------------------------------------------------
// Resource Group
// ---------------------------------------------------------------------------
const rg = new azure_native.resources.ResourceGroup("stage1-rg", {
  resourceGroupName: `rg-microservices-stage1-${env}`,
  location,
  tags,
});

// ---------------------------------------------------------------------------
// App Service Plan — Basic B2 (2 cores, 3.5 GB RAM)
// Intentionally modest to highlight monolith scaling constraints in the demo.
// ---------------------------------------------------------------------------
const asp = new azure_native.web.AppServicePlan("stage1-asp", {
  resourceGroupName: rg.name,
  location,
  name: `asp-monolith-${env}`,
  kind: "app",
  sku: { name: "B2", tier: "Basic" },
  tags,
});

// ---------------------------------------------------------------------------
// App Service — System Assigned Managed Identity for SQL access (no passwords)
// ---------------------------------------------------------------------------
const app = new azure_native.web.WebApp("monolith-app", {
  resourceGroupName: rg.name,
  location,
  name: `app-monolith-stage1-${env}`,
  serverFarmId: asp.id,
  identity: { type: "SystemAssigned" },
  httpsOnly: true,
  siteConfig: {
    netFrameworkVersion: "v8.0",
    use32BitWorkerProcess: false,
    alwaysOn: true,
    healthCheckPath: "/health",
    // WEBSITE_RUN_FROM_PACKAGE set below in app settings
  },
  tags,
});

// ---------------------------------------------------------------------------
// Azure SQL Server — Entra ID admin = App Service MI, no SQL auth password.
// Azure AD Only Authentication enabled so SQL logins are impossible;
// all access goes through managed identities.
// ---------------------------------------------------------------------------
const sqlServer = new azure_native.sql.Server("stage1-sql", {
  resourceGroupName: rg.name,
  location,
  serverName:        `sql-monolith-stage1-${env}`,
  version:           "12.0",
  minimalTlsVersion: "1.2",
  publicNetworkAccess: "Enabled",  // App Service → SQL over Azure backbone
  administrators: {
    administratorType:        "ActiveDirectory",
    azureADOnlyAuthentication: true,
    login:                    app.name,
    principalType:            "Application",
    sid:      app.identity.apply(i => i?.principalId ?? ""),
    tenantId: app.identity.apply(i => i?.tenantId   ?? ""),
  },
  tags,
}, { dependsOn: [app] });

// ---------------------------------------------------------------------------
// Monolith database — Standard S2 (50 DTUs).
// Single shared schema: the demo pain-point that Stage 2 eliminates.
// ---------------------------------------------------------------------------
const sqlDb = new azure_native.sql.Database("stage1-db", {
  resourceGroupName: rg.name,
  serverName:        sqlServer.name,
  databaseName:      `sqldb-monolith-${env}`,
  location,
  sku: { name: "S2", tier: "Standard" },
  tags,
});

// Allow Azure services to reach SQL (0.0.0.0 → 0.0.0.0 is the Azure magic range)
const sqlFw = new azure_native.sql.FirewallRule("sql-fw-azure-services", {
  resourceGroupName: rg.name,
  serverName:        sqlServer.name,
  firewallRuleName:  "AllowAzureServices",
  startIpAddress:    "0.0.0.0",
  endIpAddress:      "0.0.0.0",
});

// ---------------------------------------------------------------------------
// App Settings — MI-based connection string, no password in config
// ---------------------------------------------------------------------------
const appSettings = new azure_native.web.WebAppApplicationSettings("monolith-settings", {
  resourceGroupName: rg.name,
  name: app.name,
  properties: {
    ConnectionStrings__DefaultConnection: pulumi.interpolate`Server=tcp:${sqlServer.name}.database.windows.net,1433;Database=${sqlDb.name};Authentication=Active Directory Default;Encrypt=True;`,
    ASPNETCORE_ENVIRONMENT:  "Production",
    WEBSITE_RUN_FROM_PACKAGE: "1",
  },
}, { dependsOn: [sqlDb] });

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
export const appUrl           = pulumi.interpolate`https://${app.defaultHostName}`;
export const appServiceName   = app.name;
export const appPrincipalId   = app.identity.apply(i => i?.principalId ?? "");
export const sqlServerFqdn    = sqlServer.fullyQualifiedDomainName;
export const sqlDatabaseName  = sqlDb.name;
export const resourceGroupName = rg.name;
