import * as pulumi from "@pulumi/pulumi";
import * as azure_native from "@pulumi/azure-native";
import * as k8s from "@pulumi/kubernetes";
import * as random from "@pulumi/random";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const cfg            = new pulumi.Config();
const location       = cfg.get("location")       ?? "uksouth";
const env            = cfg.get("env")            ?? "demo";
const nodeVmSize     = cfg.get("nodeVmSize")     ?? "Standard_D4ds_v5";
const nodeCount      = cfg.getNumber("nodeCount") ?? 3;
const publisherEmail = cfg.get("publisherEmail") ?? "platform@example.com";
const publisherName  = cfg.get("publisherName")  ?? "Platform Team";

// ---------------------------------------------------------------------------
// Resource Group
// ---------------------------------------------------------------------------
const rg = new azure_native.resources.ResourceGroup("stage2-rg", {
  resourceGroupName: `rg-microservices-stage2-${env}`,
  location,
  tags: { stage: "2", env },
});

// ---------------------------------------------------------------------------
// Networking — hub VNet + AKS subnet + APIM subnet
// ---------------------------------------------------------------------------
const vnet = new azure_native.network.VirtualNetwork("stage2-vnet", {
  resourceGroupName: rg.name,
  location,
  virtualNetworkName: `vnet-stage2-${env}`,
  addressSpace: { addressPrefixes: ["10.10.0.0/16"] },
});

const aksSubnet = new azure_native.network.Subnet("aks-subnet", {
  resourceGroupName: rg.name,
  virtualNetworkName: vnet.name,
  subnetName: "snet-aks",
  addressPrefix: "10.10.0.0/22",
});

const apimSubnet = new azure_native.network.Subnet("apim-subnet", {
  resourceGroupName: rg.name,
  virtualNetworkName: vnet.name,
  subnetName: "snet-apim",
  addressPrefix: "10.10.4.0/27",
});

const peSubnet = new azure_native.network.Subnet("pe-subnet", {
  resourceGroupName: rg.name,
  virtualNetworkName: vnet.name,
  subnetName: "snet-pe",
  addressPrefix: "10.10.5.0/27",
  privateEndpointNetworkPolicies: "Disabled",
});

// ---------------------------------------------------------------------------
// Managed Identity for AKS + ACR pull
// ---------------------------------------------------------------------------
const aksIdentity = new azure_native.managedidentity.UserAssignedIdentity("aks-identity", {
  resourceGroupName: rg.name,
  location,
  resourceName: `id-aks-stage2-${env}`,
});

// ACR (reuse or create lightweight one for stage 2)
const acr = new azure_native.containerregistry.Registry("acr", {
  resourceGroupName: rg.name,
  location,
  registryName: `acrstage2${env}`.replace(/-/g, "").substring(0, 50),
  sku: { name: "Standard" },
  adminUserEnabled: false,
});

// AcrPull role assignment so AKS kubelet can pull images
const acrPull = new azure_native.authorization.RoleAssignment("acr-pull", {
  scope: acr.id,
  roleDefinitionId: "/providers/Microsoft.Authorization/roleDefinitions/7f951dda-4ed3-4680-a7ca-43fe172d538d",
  principalId: aksIdentity.principalId,
  principalType: "ServicePrincipal",
});

// ---------------------------------------------------------------------------
// AKS Cluster
// ---------------------------------------------------------------------------
const aks = new azure_native.containerservice.ManagedCluster("aks", {
  resourceGroupName: rg.name,
  location,
  resourceName: `aks-stage2-${env}`,
  identity: {
    type: "UserAssigned",
    userAssignedIdentities: { [aksIdentity.id]: {} },
  },
  dnsPrefix: `stage2-${env}`,
  kubernetesVersion: "1.29",
  networkProfile: {
    networkPlugin: "azure",
    networkPolicy: "cilium",
    networkDataplane: "cilium",
    serviceCidr: "10.20.0.0/16",
    dnsServiceIP: "10.20.0.10",
  },
  agentPoolProfiles: [
    {
      name: "system",
      count: 2,
      vmSize: "Standard_D2ds_v5",
      osType: "Linux",
      mode: "System",
      vnetSubnetID: aksSubnet.id,
      nodeTaints: ["CriticalAddonsOnly=true:NoSchedule"],
      enableAutoScaling: false,
    },
    {
      name: "workload",
      count: nodeCount,
      vmSize: nodeVmSize,
      osType: "Linux",
      mode: "User",
      vnetSubnetID: aksSubnet.id,
      enableAutoScaling: true,
      minCount: 2,
      maxCount: 10,
    },
  ],
  addonProfiles: {
    omsagent: { enabled: false },  // use Prometheus/Grafana instead
    azureKeyvaultSecretsProvider: { enabled: true },
  },
  oidcIssuerProfile: { enabled: true },
  securityProfile: {
    workloadIdentity: { enabled: true },
  },
}, { dependsOn: [acrPull] });

// Kubernetes provider wired to the new cluster
const k8sProvider = new k8s.Provider("k8s", {
  kubeconfig: aks.kubeConfig.apply(kc => {
    const decoded = Buffer.from(kc ?? "", "base64").toString();
    return decoded || kc;
  }),
});

// ---------------------------------------------------------------------------
// Namespaces
// ---------------------------------------------------------------------------
const services = ["catalog", "ordering", "basket", "identity", "payment", "notification"];

const namespaces = services.map(svc =>
  new k8s.core.v1.Namespace(`ns-${svc}`, {
    metadata: { name: svc },
  }, { provider: k8sProvider })
);

// ---------------------------------------------------------------------------
// Service Bus — one namespace, one topic per service, dead-letter sub
// ---------------------------------------------------------------------------
const sbNamespace = new azure_native.servicebus.Namespace("sb-ns", {
  resourceGroupName: rg.name,
  location,
  namespaceName: `sb-stage2-${env}`,
  // Standard tier (~$10/month) is sufficient for demo; upgrade to Premium for
  // private endpoints and zone redundancy in production.
  sku: { name: "Standard", tier: "Standard" },
});

const sbTopics = services.map(svc => {
  const topic = new azure_native.servicebus.Topic(`sb-topic-${svc}`, {
    resourceGroupName: rg.name,
    namespaceName: sbNamespace.name,
    topicName: `${svc}-events`,
    defaultMessageTimeToLive: "P14D",
    enablePartitioning: false,
    requiresDuplicateDetection: true,
    duplicateDetectionHistoryTimeWindow: "PT10M",
  });

  // Each other service gets a subscription (fan-out pattern)
  const subscribers = services.filter(s => s !== svc);
  const subs = subscribers.map(sub =>
    new azure_native.servicebus.Subscription(`sb-sub-${svc}-to-${sub}`, {
      resourceGroupName: rg.name,
      namespaceName: sbNamespace.name,
      topicName: topic.name,
      subscriptionName: `${sub}-reads-${svc}`,
      maxDeliveryCount: 10,
      deadLetteringOnMessageExpiration: true,
      lockDuration: "PT1M",
    })
  );

  return { svc, topic, subs };
});

// Shared listen+send rule for workload identity binding
const sbAuthRule = new azure_native.servicebus.NamespaceAuthorizationRule("sb-rule", {
  resourceGroupName: rg.name,
  namespaceName: sbNamespace.name,
  authorizationRuleName: "workload-rw",
  rights: ["Listen", "Send"],
});

// ---------------------------------------------------------------------------
// Per-service Cosmos DB accounts (catalog, basket) — serverless
// ---------------------------------------------------------------------------
function cosmosAccount(name: string, svcName: string) {
  const acct = new azure_native.documentdb.DatabaseAccount(`cosmos-${svcName}`, {
    resourceGroupName: rg.name,
    location,
    accountName: `cosmos-${svcName}-${env}`,
    kind: "GlobalDocumentDB",
    databaseAccountOfferType: "Standard",
    capabilities: [{ name: "EnableServerless" }],
    consistencyPolicy: {
      defaultConsistencyLevel: "Session",
    },
    locations: [{ locationName: location, failoverPriority: 0 }],
    enableAutomaticFailover: false,
  });

  const db = new azure_native.documentdb.SqlResourceSqlDatabase(`cosmos-db-${svcName}`, {
    resourceGroupName: rg.name,
    accountName: acct.name,
    databaseName: svcName,
    resource: { id: svcName },
  });

  return { acct, db };
}

const catalogCosmos = cosmosAccount("catalog", "catalog");
const basketCosmos  = cosmosAccount("basket",  "basket");

// ---------------------------------------------------------------------------
// Per-service Azure SQL (ordering, payment)
// ---------------------------------------------------------------------------
const sqlAdminPass = new random.RandomPassword("sql-admin-pass", {
  length: 24, special: true,
});

const sqlServer = new azure_native.sql.Server("sql-server", {
  resourceGroupName: rg.name,
  location,
  serverName: `sql-stage2-${env}`,
  administratorLogin: "sqladmin",
  administratorLoginPassword: sqlAdminPass.result,
  version: "12.0",
  minimalTlsVersion: "1.2",
  publicNetworkAccess: "Disabled",
});

function sqlDatabase(svcName: string) {
  return new azure_native.sql.Database(`sql-db-${svcName}`, {
    resourceGroupName: rg.name,
    serverName: sqlServer.name,
    databaseName: svcName,
    location,
    sku: { name: "GP_S_Gen5", tier: "GeneralPurpose", family: "Gen5", capacity: 2 },
    autoPauseDelay: 60,
    minCapacity: 0.5,
  });
}

const orderingDb = sqlDatabase("ordering");
const paymentDb  = sqlDatabase("payment");

// ---------------------------------------------------------------------------
// Key Vault — store connection strings, SQL password
// ---------------------------------------------------------------------------
const kv = new azure_native.keyvault.Vault("kv", {
  resourceGroupName: rg.name,
  location,
  vaultName: `kv-stage2-${env}`.substring(0, 24),
  properties: {
    sku: { family: "A", name: "standard" },
    tenantId: aksIdentity.tenantId,
    enableRbacAuthorization: true,
    enableSoftDelete: true,
    softDeleteRetentionInDays: 7,
    publicNetworkAccess: "Disabled",
    networkAcls: { defaultAction: "Deny", bypass: "AzureServices" },
  },
});

// Store SQL admin password
const kvSecretSql = new azure_native.keyvault.Secret("kv-sql-pass", {
  resourceGroupName: rg.name,
  vaultName: kv.name,
  secretName: "sql-admin-password",
  properties: { value: sqlAdminPass.result },
});

// Store SB connection string
const sbPrimaryKey = azure_native.servicebus.listNamespaceKeysOutput({
  resourceGroupName: rg.name,
  namespaceName: sbNamespace.name,
  authorizationRuleName: sbAuthRule.name,
});

const kvSecretSb = new azure_native.keyvault.Secret("kv-sb-conn", {
  resourceGroupName: rg.name,
  vaultName: kv.name,
  secretName: "servicebus-connection-string",
  properties: { value: sbPrimaryKey.primaryConnectionString },
});

// ---------------------------------------------------------------------------
// API Management (Developer tier for demo, Internal VNet mode)
// ---------------------------------------------------------------------------
const apimPublicIp = new azure_native.network.PublicIPAddress("apim-pip", {
  resourceGroupName: rg.name,
  location,
  publicIpAddressName: `pip-apim-stage2-${env}`,
  sku: { name: "Standard" },
  publicIPAllocationMethod: "Static",
  dnsSettings: { domainNameLabel: `apim-stage2-${env}` },
});

const apim = new azure_native.apimanagement.ApiManagementService("apim", {
  resourceGroupName: rg.name,
  location,
  serviceName: `apim-stage2-${env}`,
  sku: { name: "Developer", capacity: 1 },
  publisherEmail,
  publisherName,
  virtualNetworkType: "External",
  virtualNetworkConfiguration: { subnetResourceId: apimSubnet.id },
  publicIpAddressId: apimPublicIp.id,
  identity: { type: "SystemAssigned" },
}, { dependsOn: [apimSubnet] });

// APIM products — internal vs external consumers
const internalProduct = new azure_native.apimanagement.Product("apim-product-internal", {
  resourceGroupName: rg.name,
  serviceName: apim.name,
  productId: "internal",
  displayName: "Internal Services",
  description: "APIs for internal service-to-service consumption",
  subscriptionRequired: true,
  approvalRequired: false,
  state: "published",
});

// One API per microservice pointing to AKS ingress
services.forEach(svc => {
  new azure_native.apimanagement.Api(`apim-api-${svc}`, {
    resourceGroupName: rg.name,
    serviceName: apim.name,
    apiId: svc,
    displayName: `${svc.charAt(0).toUpperCase() + svc.slice(1)} API`,
    path: svc,
    protocols: ["https"],
    serviceUrl: pulumi.interpolate`http://${svc}.${svc}.svc.cluster.local`,  // internal cluster DNS
    subscriptionRequired: false,
    apiType: "http",
    format: "openapi",
    // value: load from file in CI — omitted here for clarity
  });
});

// ---------------------------------------------------------------------------
// Private Endpoints — Cosmos, SQL, KV, Service Bus → pe subnet
// ---------------------------------------------------------------------------
function privateEndpoint(
  name: string,
  targetId: pulumi.Input<string>,
  groupId: string,
) {
  return new azure_native.network.PrivateEndpoint(`pe-${name}`, {
    resourceGroupName: rg.name,
    location,
    privateEndpointName: `pe-${name}-${env}`,
    subnet: { id: peSubnet.id },
    privateLinkServiceConnections: [{
      name,
      privateLinkServiceId: targetId,
      groupIds: [groupId],
    }],
  });
}

const peCatalogCosmos = privateEndpoint("cosmos-catalog", catalogCosmos.acct.id, "Sql");
const peBasketCosmos  = privateEndpoint("cosmos-basket",  basketCosmos.acct.id,  "Sql");
const peSqlServer     = privateEndpoint("sql-server",     sqlServer.id,           "sqlServer");
const peKv            = privateEndpoint("kv",             kv.id,                  "vault");
// NOTE: Service Bus Standard tier does not support private endpoints.
// For production (Premium tier), add: privateEndpoint("servicebus", sbNamespace.id, "namespace")

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------
export const aksClusterName     = aks.name;
export const aksResourceGroup   = rg.name;
export const acrLoginServer     = acr.loginServer;
export const apimGatewayUrl     = apim.gatewayUrl;
export const apimPortalUrl      = apim.portalUrl;
export const serviceBusNs       = sbNamespace.name;
export const keyVaultUri        = kv.properties.apply(p => p.vaultUri);
export const sqlServerFqdn      = sqlServer.fullyQualifiedDomainName;
export const catalogCosmosAcct  = catalogCosmos.acct.name;
export const basketCosmosAcct   = basketCosmos.acct.name;
export const vnetId             = vnet.id;
