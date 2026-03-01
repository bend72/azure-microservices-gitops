/**
 * tests/k6/smoke.js
 *
 * End-to-end smoke test covering the full eShop order flow:
 *   browse catalog → add to basket → submit order → poll notification
 *
 * Designed to run in three modes:
 *   smoke    — 10s, 2 VUs  (CI gate after every deploy)
 *   load     — 5m,  20 VUs (nightly, validates KEDA scaling)
 *   soak     — 30m, 5 VUs  (weekly, catches memory leaks)
 *
 * Usage:
 *   k6 run --env SCENARIO=smoke tests/k6/smoke.js
 *   k6 run --env SCENARIO=load  tests/k6/smoke.js
 *   k6 run --out experimental-prometheus-rw=http://prometheus:9090/api/v1/write \
 *          --env SCENARIO=smoke tests/k6/smoke.js
 */

import http       from "k6/http";
import { check, group, sleep } from "k6";
import { Trend, Rate, Counter } from "k6/metrics";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

// ── Custom metrics ────────────────────────────────────────────────────────────
const orderLatency        = new Trend("order_e2e_latency_ms", true);
const notificationLatency = new Trend("notification_poll_latency_ms", true);
const orderSuccessRate    = new Rate("order_success_rate");
const ordersPlaced        = new Counter("orders_placed_total");

// ── Config ────────────────────────────────────────────────────────────────────
const BASE         = __ENV.APIM_GATEWAY  ?? "https://apim-stage2-demo.azure-api.net";
const APIM_KEY     = __ENV.APIM_KEY      ?? "";
const SCENARIO     = __ENV.SCENARIO      ?? "smoke";

const COMMON_HEADERS = {
  "Content-Type":               "application/json",
  "Ocp-Apim-Subscription-Key": APIM_KEY,
};

// ── Scenarios ─────────────────────────────────────────────────────────────────
const SCENARIOS = {
  smoke: {
    executor:         "constant-vus",
    vus:              2,
    duration:         "10s",
    gracefulStop:     "5s",
  },
  load: {
    executor:         "ramping-vus",
    startVUs:         0,
    stages: [
      { duration: "1m",  target: 10  },   // ramp up
      { duration: "3m",  target: 20  },   // hold — should trigger KEDA scale-out
      { duration: "1m",  target: 0   },   // ramp down
    ],
    gracefulRampDown: "30s",
  },
  soak: {
    executor:         "constant-vus",
    vus:              5,
    duration:         "30m",
    gracefulStop:     "30s",
  },
};

// ── Thresholds ────────────────────────────────────────────────────────────────
export const options = {
  scenarios:  { [SCENARIO]: SCENARIOS[SCENARIO] },
  thresholds: {
    // All scenarios
    http_req_failed:       ["rate<0.01"],           // <1% HTTP errors
    http_req_duration:     ["p(95)<1500"],           // 95th pct < 1.5s
    order_success_rate:    ["rate>0.99"],            // >99% orders complete
    order_e2e_latency_ms:  ["p(95)<3000"],           // end-to-end < 3s

    // Load + soak only — relaxed for smoke
    ...(SCENARIO !== "smoke" && {
      notification_poll_latency_ms: ["p(95)<5000"],
    }),
  },
  // Output structured summary for Backstage TechDocs / CI annotations
  summaryTrendStats: ["min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

// ── Seed data ─────────────────────────────────────────────────────────────────
// A small set of product IDs seeded into Cosmos by the dev fixture loader.
const PRODUCT_IDS = [
  "prod-001", "prod-002", "prod-003",
  "prod-004", "prod-005",
];

function randomProduct() {
  return PRODUCT_IDS[Math.floor(Math.random() * PRODUCT_IDS.length)];
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function get(path, tag) {
  return http.get(`${BASE}${path}`, {
    headers: COMMON_HEADERS,
    tags:    { name: tag ?? path },
  });
}

function post(path, body, tag) {
  return http.post(`${BASE}${path}`, JSON.stringify(body), {
    headers: COMMON_HEADERS,
    tags:    { name: tag ?? path },
  });
}

function assertOk(res, label) {
  return check(res, {
    [`${label}: status 2xx`]: r => r.status >= 200 && r.status < 300,
    [`${label}: no body error`]: r => {
      try {
        const b = JSON.parse(r.body);
        return !b.error && !b.errors;
      } catch { return true; }  // non-JSON body is fine (204s etc.)
    },
  });
}

// ── Setup — verify all services are reachable before the test starts ──────────
export function setup() {
  const services = ["catalog", "ordering", "basket", "identity", "payment", "notification"];
  const results  = {};

  for (const svc of services) {
    const res = get(`/${svc}/healthz/ready`, `healthcheck-${svc}`);
    results[svc] = res.status;
    check(res, { [`${svc} healthy`]: r => r.status === 200 });
  }

  console.log("Setup health checks:", JSON.stringify(results));
  return { startTime: Date.now() };
}

// ── Main VU function ──────────────────────────────────────────────────────────
export default function () {
  const userId  = `user-${__VU}-${__ITER}`;
  const orderId = uuidv4();
  const productId = randomProduct();
  let   basketId  = null;
  let   orderOk   = false;

  const flowStart = Date.now();

  // ── Step 1: Browse catalog ──────────────────────────────────────────────────
  group("1_browse_catalog", () => {
    const listRes = get("/catalog/api/v1/products?pageSize=10&pageIndex=0", "catalog_list");
    assertOk(listRes, "catalog list");

    const detailRes = get(`/catalog/api/v1/products/${productId}`, "catalog_detail");
    assertOk(detailRes, "catalog detail");

    // Verify the product payload has expected fields
    check(detailRes, {
      "product has id":    r => JSON.parse(r.body).id === productId,
      "product has price": r => JSON.parse(r.body).price > 0,
    });
  });

  sleep(0.3 + Math.random() * 0.4);  // ~300–700ms think time

  // ── Step 2: Create basket ───────────────────────────────────────────────────
  group("2_basket", () => {
    const createRes = post("/basket/api/v1/basket", {
      buyerId: userId,
      items:   [{ productId, productName: "Demo Product", unitPrice: 9.99, quantity: 1 }],
    }, "basket_create");

    if (assertOk(createRes, "basket create")) {
      basketId = JSON.parse(createRes.body).buyerId ?? userId;
    }

    sleep(0.2);

    // Update quantity — simulates the user adding another item
    const updateRes = post(`/basket/api/v1/basket`, {
      buyerId: basketId ?? userId,
      items:   [{ productId, productName: "Demo Product", unitPrice: 9.99, quantity: 2 }],
    }, "basket_update");
    assertOk(updateRes, "basket update");
  });

  sleep(0.2 + Math.random() * 0.3);

  // ── Step 3: Submit order ────────────────────────────────────────────────────
  group("3_place_order", () => {
    const checkoutRes = post("/ordering/api/v1/orders", {
      userId,
      orderId,
      basketId:         basketId ?? userId,
      city:             "London",
      street:           "1 Demo Lane",
      country:          "UK",
      zipCode:          "EC1A 1BB",
      cardNumber:       "4111111111111111",
      cardHolderName:   "Test User",
      cardExpiration:   "12/2026",
      cardSecurityNumber: "123",
      cardTypeId:       1,
    }, "order_create");

    orderOk = assertOk(checkoutRes, "order create");

    if (orderOk) {
      ordersPlaced.add(1);
      check(checkoutRes, {
        "order has orderId": r => {
          try { return JSON.parse(r.body).orderId !== undefined; }
          catch { return checkoutRes.status === 202; }  // some impls return 202 + empty body
        },
      });
    }
  });

  orderSuccessRate.add(orderOk);
  orderLatency.add(Date.now() - flowStart);

  sleep(0.5);

  // ── Step 4: Poll notification service for the OrderPlaced event ─────────────
  // The ordering service publishes to Service Bus via Dapr; notification consumes it.
  // We poll up to 5s — acceptable for demo latency, not production SLA.
  if (orderOk) {
    group("4_notification_poll", () => {
      const pollStart = Date.now();
      let   notified  = false;
      let   attempts  = 0;
      const maxWaitMs = 5000;

      while (!notified && (Date.now() - pollStart) < maxWaitMs) {
        attempts++;
        const res = get(
          `/notification/api/v1/notifications/${userId}?limit=5`,
          "notification_poll"
        );

        if (res.status === 200) {
          try {
            const body = JSON.parse(res.body);
            const events = Array.isArray(body) ? body : body.notifications ?? [];
            notified = events.some(e =>
              e.type === "OrderPlaced" && e.orderId === orderId
            );
          } catch (_) { /* non-JSON, keep polling */ }
        }

        if (!notified) sleep(0.5);
      }

      notificationLatency.add(Date.now() - pollStart);

      check({}, {
        [`notification received in <5s (attempts: ${attempts})`]: () => notified,
      });
    });
  }

  sleep(1 + Math.random());  // idle before next iteration
}

// ── Teardown — print summary to stdout for CI log capture ────────────────────
export function teardown(data) {
  const elapsed = ((Date.now() - data.startTime) / 1000).toFixed(1);
  console.log(`Test complete in ${elapsed}s`);
}

// ── Custom summary — emits GitHub Actions annotations on threshold breach ────
export function handleSummary(data) {
  const failures = [];

  for (const [metric, result] of Object.entries(data.metrics)) {
    if (result.thresholds) {
      for (const [expr, passed] of Object.entries(result.thresholds)) {
        if (!passed.ok) {
          failures.push(`::error title=k6 threshold breach::${metric} failed: ${expr}`);
        }
      }
    }
  }

  // Print GitHub Actions annotations to stdout so they surface in the CI log
  if (failures.length > 0) {
    console.log(failures.join("\n"));
  }

  return {
    stdout: JSON.stringify({
      scenario:       SCENARIO,
      thresholdsFailed: failures.length,
      ordersPlaced:   data.metrics.orders_placed_total?.values?.count ?? 0,
      orderSuccessRate: data.metrics.order_success_rate?.values?.rate ?? 0,
      p95Latency:     data.metrics.order_e2e_latency_ms?.values?.["p(95)"] ?? 0,
    }, null, 2),
    // Write full JSON results to file for Backstage TechDocs ingestion
    "tests/k6/results/latest.json": JSON.stringify(data, null, 2),
  };
}