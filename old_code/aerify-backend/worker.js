var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var worker_default = {
  async fetch(request, env) {
    const origin = request.headers.get("origin") || "";
    try {
      const url = new URL(request.url);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors(origin) });
      }
      if (url.pathname === "/products" && request.method === "GET") return handleProducts(env, origin);
      if (url.pathname === "/homepage-products" && request.method === "GET") return handleHomepageProducts(env, origin);
      if (url.pathname === "/create-checkout" && request.method === "POST") return handleCreateCheckout(request, env, origin);
      if (url.pathname === "/complete-order" && request.method === "POST") return handleStripeWebhook(request, env, origin);
      if (url.pathname === "/order-status" && request.method === "GET") return handleOrderStatus(request, env, origin);
      if (url.pathname === "/my-esims" && request.method === "GET") return handleMyEsims(request, env, origin);
      if (url.pathname.startsWith("/esim-usage/") && request.method === "GET") return handleEsimUsage(request, env, origin);
      if (url.pathname.startsWith("/topup-packages/") && request.method === "GET") return handleTopupPackages(request, env, origin);
      if (url.pathname === "/topup-checkout" && request.method === "POST") return handleTopupCheckout(request, env, origin);
      return new Response("Not Found", { status: 404, headers: cors(origin) });
    } catch (err2) {
      console.error("Worker crash:", err2);
      return new Response("Server error", { status: 500, headers: cors(origin) });
    }
  }
};
function cors(origin) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,Stripe-Signature"
  };
}
__name(cors, "cors");
async function getAuth0User(request, env) {
  const authHeader = request.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return null;
  try {
    const res = await fetch(`https://${env.AUTH0_DOMAIN}/userinfo`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}
__name(getAuth0User, "getAuth0User");
async function getAiraloToken(env) {
  const body = new FormData();
  body.append("client_id", env.AIRALO_CLIENT_ID);
  body.append("client_secret", env.AIRALO_CLIENT_SECRET);
  body.append("grant_type", "client_credentials");
  const res = await fetch(`${env.AIRALO_BASE_URL}/v2/token`, {
    method: "POST",
    headers: { Accept: "application/json" },
    body
  });
  if (!res.ok) {
    console.error(await res.text());
    throw new Error("Airalo auth failed");
  }
  const json = await res.json();
  return json.data.access_token;
}
__name(getAiraloToken, "getAiraloToken");
async function getSimplifiedProducts(env) {
  const cacheKey = new Request("https://cache.internal/aerify-products-v2");
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return cached.json();
  const token = await getAiraloToken(env);
  const res = await fetch(`${env.AIRALO_BASE_URL}/v2/packages?limit=5000`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("Airalo fetch failed:", errText);
    throw new Error("Airalo fetch failed");
  }
  const apiJson = await res.json();
  const simplified = [];
  for (const loc of apiJson.data || []) {
    const country = loc.title;
    const countryCode = loc.country_code;
    const imageUrl = loc.image?.url;
    for (const op of loc.operators || []) {
      const category = resolveCategory(op.type, countryCode, country);
      for (const pkg of op.packages || []) {
        const baseUSD = pkg.net_price ?? pkg.prices?.net_price?.USD;
        if (!baseUSD || baseUSD <= 0) continue;
        const markup = Number(env.MARKUP_PERCENT || 0) / 100;
        const priceUSD = +(baseUSD * (1 + markup)).toFixed(2);
        simplified.push({
          id: pkg.id,
          name: pkg.title || pkg.name,
          operator: op.name,
          operatorImage: op.image?.url,
          country,
          countryCode,
          category,
          dataAmount: pkg.data,
          validityDays: pkg.day || pkg.validity,
          baseUSD,
          priceUSD,
          imageUrl,
          networks: op.coverages?.flatMap((c) => c.networks?.map((n) => n.name) || []) || [],
          isUnlimited: !!pkg.is_unlimited
        });
      }
    }
  }
  const toCache = new Response(JSON.stringify(simplified), {
    headers: { "Content-Type": "application/json", "Cache-Control": "max-age=600" }
  });
  await cache.put(cacheKey, toCache);
  return simplified;
}
__name(getSimplifiedProducts, "getSimplifiedProducts");
async function handleProducts(env, origin) {
  try {
    const products = await getSimplifiedProducts(env);
    return jsonRes(products, 200, origin);
  } catch {
    return err("Airalo fetch failed", 500, origin);
  }
}
async function handleHomepageProducts(env, origin) {
  const HOME_LIMIT = 12;
  const cacheKey = new Request("https://cache.internal/aerify-homepage-products-v2");
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) return jsonRes(await cached.json(), 200, origin);
  let products;
  try {
    products = await getSimplifiedProducts(env);
  } catch {
    return err("Airalo fetch failed", 500, origin);
  }
  // Group all packages by category
  const groups = { country: [], regional: [], global: [] };
  for (const p of products) {
    if (groups[p.category] !== undefined) {
      groups[p.category].push(p);
    }
  }
  const limited = [];
  for (const cat of Object.keys(groups)) {
    // Deduplicate to one package per unique country name (cheapest price wins)
    const cheapestByCountry = new Map();
    for (const p of groups[cat]) {
      const existing = cheapestByCountry.get(p.country);
      if (!existing || p.priceUSD < existing.priceUSD) {
        cheapestByCountry.set(p.country, p);
      }
    }
    // Sort unique destinations by price, keep top 12
    const top = Array.from(cheapestByCountry.values())
      .sort((a, b) => a.priceUSD - b.priceUSD)
      .slice(0, HOME_LIMIT);
    limited.push(...top);
  }
  const toCache = new Response(JSON.stringify(limited), {
    headers: { "Content-Type": "application/json", "Cache-Control": "max-age=600" }
  });
  await cache.put(cacheKey, toCache);
  return jsonRes(limited, 200, origin);
}
__name(handleProducts, "handleProducts");
__name(handleHomepageProducts, "handleHomepageProducts");
function resolveCategory(type, cc, countryName) {
  if (!cc || cc.trim() === "") {
    if (countryName === "Discover Global") {
      return "global";
    }
    return "regional";
  }
  if (cc.length === 2) {
    return "country";
  }
  return "country";
}
__name(resolveCategory, "resolveCategory");
async function handleCreateCheckout(request, env, origin) {
  if (env.KV) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const rlKey = `rl:checkout:${ip}`;
    const count = parseInt(await env.KV.get(rlKey) || "0");
    if (count >= 10) return err("Too many requests", 429, origin);
    await env.KV.put(rlKey, String(count + 1), { expirationTtl: 60 });
  }
  const user = await getAuth0User(request, env);
  const body = await request.json();
  const {
    packageId,
    country,
    countryCode,
    dataAmount,
    validityDays,
    priceUSD,
    imageUrl,
    operator,
    planName
  } = body;
  if (!packageId) return err("packageId required", 400, origin);
  if (!priceUSD || Number(priceUSD) <= 0) return err("Invalid price", 400, origin);
  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("success_url", `${env.FRONTEND_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`);
  params.append("cancel_url", `${env.FRONTEND_BASE_URL}/cancel.html`);
  params.append("line_items[0][quantity]", "1");
  params.append("line_items[0][price_data][currency]", "usd");
  params.append("line_items[0][price_data][unit_amount]", String(Math.round(Number(priceUSD) * 100)));
  params.append("line_items[0][price_data][product_data][name]", `${dataAmount} eSIM \u2014 ${country} (${validityDays} days)`);
  params.append("line_items[0][price_data][product_data][description]", `Powered by ${operator}`);
  params.append("metadata[package_id]", packageId);
  params.append("metadata[country]", country || "");
  params.append("metadata[country_code]", countryCode || "");
  params.append("metadata[image_url]", imageUrl || "");
  params.append("metadata[plan_name]", planName || "");
  params.append("metadata[data_amount]", dataAmount || "");
  params.append("metadata[validity_days]", String(validityDays || ""));
  if (user?.sub) params.append("metadata[user_id]", user.sub);
  if (user?.email) params.append("metadata[user_email]", user.email);
  if (user?.email) params.append("customer_email", user.email);
  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  const stripeJson = await stripeRes.json();
  if (!stripeRes.ok) {
    console.error("Stripe error", stripeJson);
    return err("Stripe error", 500, origin);
  }
  return jsonRes({ url: stripeJson.url }, 200, origin);
}
__name(handleCreateCheckout, "handleCreateCheckout");
async function handleOrderStatus(request, env, origin) {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");
  if (!sessionId) return err("session_id required", 400, origin);
  const id = env.ORDER_DO.idFromName(sessionId);
  const stub = env.ORDER_DO.get(id);
  const res = await stub.fetch("https://order/status", { method: "GET" });
  const status = await res.text();
  return jsonRes({ status }, 200, origin);
}
__name(handleOrderStatus, "handleOrderStatus");
async function handleStripeWebhook(request, env, origin) {
  const body = await request.text();
  const signature = request.headers.get("stripe-signature");
  if (!signature) return err("Missing signature", 400, origin);
  const isValid = await verifyStripeSignature(body, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!isValid) return err("Invalid signature", 400, origin);
  let event;
  try {
    event = JSON.parse(body);
  } catch {
    return err("Invalid JSON", 400, origin);
  }
  if (event.type !== "checkout.session.completed") return jsonRes({ message: "Ignored" }, 200, origin);
  const sessionId = event.data.object.id;
  const id = env.ORDER_DO.idFromName(sessionId);
  const stub = env.ORDER_DO.get(id);
  const doRes = await stub.fetch("https://order/process", {
    method: "POST",
    body: JSON.stringify({ sessionId })
  });
  const text = await doRes.text();
  return new Response(text, { status: doRes.status, headers: { ...cors(origin), "Content-Type": "text/plain" } });
}
__name(handleStripeWebhook, "handleStripeWebhook");
async function verifyStripeSignature(body, header, secret) {
  try {
    const parts = Object.fromEntries(header.split(",").map((p) => p.split("=")));
    const timestamp = parts["t"];
    const sig = parts["v1"];
    if (!timestamp || !sig) return false;
    if (Math.abs(Date.now() / 1e3 - Number(timestamp)) > 300) return false;
    const payload = `${timestamp}.${body}`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
    const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (expected.length !== sig.length) return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    return diff === 0;
  } catch {
    return false;
  }
}
__name(verifyStripeSignature, "verifyStripeSignature");
async function handleMyEsims(request, env, origin) {
  const user = await getAuth0User(request, env);
  if (!user?.sub) return err("Unauthorized", 401, origin);
  const userKey = `user:${user.sub}:esims`;
  const emailKey = `email:${user.email}:esims`;
  const raw = env.KV ? await env.KV.get(userKey) : null;
  const emailRaw = env.KV ? await env.KV.get(emailKey) : null;
  const userEsims = raw ? JSON.parse(raw) : [];
  const emailEsims = emailRaw ? JSON.parse(emailRaw) : [];
  const merged = [...userEsims];
  for (const sim of emailEsims) {
    if (!merged.find((s) => s.iccid === sim.iccid)) merged.push(sim);
  }
  if (emailEsims.length && env.KV) {
    await env.KV.put(userKey, JSON.stringify(merged));
    await env.KV.delete(emailKey);
  }
  const esims = merged;
  const token = await getAiraloToken(env).catch(() => null);
  const enriched = await Promise.all(esims.map(async (sim) => {
    if (!token || !sim.iccid) return sim;
    try {
      const usageRes = await fetch(`${env.AIRALO_BASE_URL}/v2/sims/${sim.iccid}/usage`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
      });
      if (usageRes.ok) {
        const usageJson = await usageRes.json();
        return { ...sim, usage: usageJson.data };
      }
    } catch {
    }
    return sim;
  }));
  return jsonRes({ esims: enriched }, 200, origin);
}
__name(handleMyEsims, "handleMyEsims");
async function handleEsimUsage(request, env, origin) {
  const user = await getAuth0User(request, env);
  if (!user?.sub) return err("Unauthorized", 401, origin);
  const iccid = new URL(request.url).pathname.split("/").pop();
  if (!iccid) return err("iccid required", 400, origin);
  const raw = env.KV ? await env.KV.get(`user:${user.sub}:esims`) : null;
  const esims = raw ? JSON.parse(raw) : [];
  if (!esims.find((s) => s.iccid === iccid)) return err("Not found", 404, origin);
  const token = await getAiraloToken(env);
  const res = await fetch(`${env.AIRALO_BASE_URL}/v2/sims/${iccid}/usage`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
  });
  if (!res.ok) return err("Usage fetch failed", 500, origin);
  const json = await res.json();
  return jsonRes(json.data, 200, origin);
}
__name(handleEsimUsage, "handleEsimUsage");
async function handleTopupPackages(request, env, origin) {
  const user = await getAuth0User(request, env);
  if (!user?.sub) return err("Unauthorized not logged in", 401, origin);

  const iccid = new URL(request.url).pathname.split("/").pop();
  const raw = env.KV ? await env.KV.get(`user:${user.sub}:esims`) : null;
  const esims = raw ? JSON.parse(raw) : [];
  if (!esims.find((s) => s.iccid === iccid)) return err("Not found", 404, origin);

  const token = await getAiraloToken(env);
  const res = await fetch(`${env.AIRALO_BASE_URL}/v2/sims/${iccid}/topups`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`Airalo topup-packages failed [${res.status}]:`, body);
    return err("Topup packages fetch failed", 500, origin);
  }

  const json = await res.json();
  const markup = Number(env.MARKUP_PERCENT || 0) / 100;
  const packages = (json.data || []).map((pkg) => ({
    id: pkg.id,
    dataAmount: pkg.data,
    validityDays: pkg.day || pkg.validity,
    priceUSD: (pkg.net_price == null && pkg.price == null)
      ? null
      : +((pkg.net_price ?? pkg.price) * (1 + markup)).toFixed(2)
  })).filter((pkg) => pkg.priceUSD !== null && pkg.priceUSD > 0);
  return jsonRes({ packages }, 200, origin);
}
__name(handleTopupPackages, "handleTopupPackages");
async function handleTopupCheckout(request, env, origin) {
  const user = await getAuth0User(request, env);
  if (!user?.sub) return err("Unauthorized", 401, origin);
  const { packageId, iccid } = await request.json();
  if (!packageId || !iccid) return err("packageId and iccid required", 400, origin);
  const raw = env.KV ? await env.KV.get(`user:${user.sub}:esims`) : null;
  const esims = raw ? JSON.parse(raw) : [];
  const sim = esims.find((s) => s.iccid === iccid);
  if (!sim) return err("eSIM not found", 404, origin);
  const token = await getAiraloToken(env);
  const pkgRes = await fetch(`${env.AIRALO_BASE_URL}/v2/sims/${iccid}/topups`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}` }
  });
  if (!pkgRes.ok) return err("Package fetch failed", 500, origin);
  const pkgJson = await pkgRes.json();
  const pkg = (pkgJson.data || []).find((p) => p.id === packageId);
  if (!pkg) return err("Package not found", 404, origin);
  const markup = Number(env.MARKUP_PERCENT || 0) / 100;
  const rawPrice = pkg.net_price ?? pkg.price;
  if (!rawPrice || rawPrice <= 0) return err("Invalid package price", 500, origin);
  const priceUSD = +(rawPrice * (1 + markup)).toFixed(2);
  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("success_url", `${env.FRONTEND_BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`);
  params.append("cancel_url", `${env.FRONTEND_BASE_URL}/my-esims.html`);
  params.append("line_items[0][quantity]", "1");
  params.append("line_items[0][price_data][currency]", "usd");
  params.append("line_items[0][price_data][unit_amount]", String(Math.round(priceUSD * 100)));
  params.append("line_items[0][price_data][product_data][name]", `Top-Up ${pkg.data} \u2014 ${sim.country}`);
  params.append("metadata[type]", "topup");
  params.append("metadata[package_id]", pkg.id);
  params.append("metadata[iccid]", iccid);
  params.append("metadata[user_id]", user.sub);
  if (user.email) {
    params.append("metadata[user_email]", user.email);
    params.append("customer_email", user.email);
  }
  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params
  });
  const stripeJson = await stripeRes.json();
  if (!stripeRes.ok) {
    console.error("Stripe topup error", stripeJson);
    return err("Stripe error", 500, origin);
  }
  return jsonRes({ url: stripeJson.url }, 200, origin);
}
__name(handleTopupCheckout, "handleTopupCheckout");
function jsonRes(data, status = 200, origin = "") {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) }
  });
}
__name(jsonRes, "jsonRes");
function err(message, status, origin = "") {
  return jsonRes({ error: message }, status, origin);
}
__name(err, "err");
var OrderDO = class {
  static {
    __name(this, "OrderDO");
  }
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
  async fetch(request) {
    if (request.method === "GET") {
      const status2 = await this.state.storage.get("status") || "pending";
      return new Response(status2, { status: 200 });
    }
    const { sessionId } = await request.json();
    const status = await this.state.storage.get("status");
    if (status === "fulfilled") return new Response("Already processed", { status: 200 });
    if (status === "processing") return new Response("Already processing", { status: 200 });
    await this.state.storage.put("status", "processing");
    try {
      const verifyRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
        headers: { Authorization: `Bearer ${this.env.STRIPE_SECRET_KEY}` }
      });
      if (!verifyRes.ok) {
        await this.state.storage.delete("status");
        return new Response("Stripe verify failed", { status: 400 });
      }
      const session = await verifyRes.json();
      if (session.payment_status !== "paid") {
        await this.state.storage.delete("status");
        return new Response("Not paid", { status: 400 });
      }
      const meta = session.metadata || {};
      const packageId = meta.package_id;
      const email = meta.user_email || session.customer_details?.email;
      const userId = meta.user_id;
      const orderType = meta.type || "sim";
      if (!packageId || !email) {
        await this.state.storage.delete("status");
        return new Response("Missing metadata", { status: 400 });
      }
      const token = await getAiraloToken(this.env);
      const form = new FormData();
      if (orderType === "topup") {
        form.append("package_id", packageId);
        form.append("iccid", meta.iccid);
        form.append("description", `Topup (${meta.iccid})`);
      } else {
        form.append("package_id", packageId);
        form.append("quantity", "1");
        form.append("type", "sim");
        form.append("to_email", email);
        form.append("sharing_option[]", "link");
      }
      const airaloEndpoint = orderType === "topup"
        ? `${this.env.AIRALO_BASE_URL}/v2/orders/topups`
        : `${this.env.AIRALO_BASE_URL}/v2/orders`;
      const airaloRes = await fetch(airaloEndpoint, {
        method: "POST",
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        body: form
      });
      if (!airaloRes.ok) {
        const txt = await airaloRes.text();
        console.error("Airalo order failed:", txt);
        await this.state.storage.delete("status");
        return new Response("Fulfillment failed", { status: 500 });
      }
      const airaloJson = await airaloRes.json();
      const orderData = airaloJson.data;
      if ((userId || email) && this.env.KV && orderType !== "topup") {
        const sim = orderData.sims?.[0] || {};
        const record = {
          iccid: sim.iccid,
          qrcode: sim.qrcode,
          qrcodeUrl: sim.qrcode_url,
          smdpAddress: sim.lpa,
          matchingId: sim.matching_id,
          appleUrl: sim.direct_apple_installation_url,
          packageId,
          country: meta.country,
          countryCode: meta.country_code,
          imageUrl: meta.image_url,
          planName: meta.plan_name,
          dataAmount: meta.data_amount,
          validityDays: meta.validity_days,
          orderedAt: (/* @__PURE__ */ new Date()).toISOString(),
          orderId: orderData.id
        };
        const kvKey = userId ? `user:${userId}:esims` : `email:${email}:esims`;
        const existing = await this.env.KV.get(kvKey);
        const list = existing ? JSON.parse(existing) : [];
        list.unshift(record);
        await this.env.KV.put(kvKey, JSON.stringify(list));
      }
      await this.state.storage.put("status", "fulfilled");
      return new Response("Order fulfilled", { status: 200 });
    } catch (err2) {
      console.error("DO error:", err2);
      await this.state.storage.delete("status");
      return new Response("Internal error", { status: 500 });
    }
  }
};
export {
  OrderDO,
  worker_default as default
};
//# sourceMappingURL=worker.js.map
