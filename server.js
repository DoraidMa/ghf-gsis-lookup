import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;

// -------------------- ENV --------------------
const API_KEY = process.env.API_KEY || "";
const CACHE_TTL_DAYS = Number(process.env.CACHE_TTL_DAYS || 30);
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * CACHE_TTL_DAYS;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// -------------------- CORS --------------------
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// -------------------- API KEY --------------------
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // allow if not set (not recommended)
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

// -------------------- CACHE --------------------
const cache = new Map();
function makeCacheKey(obj) {
  return crypto.createHash("md5").update(JSON.stringify(obj)).digest("hex");
}
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}
function cacheSet(key, data) {
  cache.set(key, { ts: Date.now(), data });
}

// -------------------- GSIS CONSTANTS --------------------
const GSIS_APP_URL = "https://maps.gsis.gr/valuemaps/";
const GSIS_PROXY_BASE = "https://maps.gsis.gr/valuemaps2/PHP/proxy.php?";

// IMPORTANT: from your DevTools capture, the zip-search uses this service/layer
const ZIP_LAYER_URL =
  "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2018_INFO/MapServer/18/query";

// Point query (may work; if it returns no attrs, you can switch layer once we identify it)
const POINT_LAYER_URL =
  "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/1/query";

// -------------------- Browser-ish headers --------------------
function browserHeaders() {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-GB,en;q=0.9",
    "Referer": GSIS_APP_URL,
    "Origin": "https://maps.gsis.gr",
    "Connection": "keep-alive",
  };
}

// -------------------- Minimal cookie jar (manual) --------------------
let gsisCookies = "";     // "k=v; k2=v2"
let lastWarmTs = 0;
const WARM_TTL_MS = 1000 * 60 * 10; // warm every 10 minutes

function parseSetCookieHeaders(res) {
  // Node 20 fetch (undici) has getSetCookie()
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const sc = res.headers.get("set-cookie");
  return sc ? [sc] : [];
}

function mergeCookieJar(existing, setCookieHeaders) {
  const jar = new Map();

  // existing cookies
  (existing || "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean)
    .forEach((kv) => {
      const i = kv.indexOf("=");
      if (i === -1) return;
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    });

  // new cookies
  for (const h of setCookieHeaders || []) {
    // split multiple cookies safely
    const parts = String(h).split(/,(?=[^;]+?=)/g);
    for (const one of parts) {
      const first = one.split(";")[0].trim();
      const i = first.indexOf("=");
      if (i === -1) continue;
      jar.set(first.slice(0, i), first.slice(i + 1));
    }
  }

  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function warmGsisSession() {
  if (Date.now() - lastWarmTs < WARM_TTL_MS && gsisCookies) return;

  // 1) Load valuemaps app (sets baseline cookies)
  try {
    const r1 = await fetch(GSIS_APP_URL, {
      method: "GET",
      headers: {
        ...browserHeaders(),
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    gsisCookies = mergeCookieJar(gsisCookies, parseSetCookieHeaders(r1));
    await r1.text();
  } catch {
    // ignore
  }

  // 2) Warm via proxy calling a harmless ArcGIS info endpoint (sets AGS_ROLES)
  try {
    const warmTarget = "https://maps.gsis.gr/arcgis/rest/info?f=json";
    const r2 = await fetch(`${GSIS_PROXY_BASE}${warmTarget}`, {
      method: "GET",
      headers: {
        ...browserHeaders(),
        ...(gsisCookies ? { Cookie: gsisCookies } : {}),
      },
    });
    gsisCookies = mergeCookieJar(gsisCookies, parseSetCookieHeaders(r2));
    await r2.text();
  } catch {
    // ignore
  }

  lastWarmTs = Date.now();
}

// IMPORTANT: GSIS proxy expects RAW target URL after '?', NOT URL-encoded.
async function gsisProxyJson(targetUrl) {
  await warmGsisSession();

  const proxyUrl = `${GSIS_PROXY_BASE}${targetUrl}`;

  const r = await fetch(proxyUrl, {
    method: "GET",
    headers: {
      ...browserHeaders(),
      ...(gsisCookies ? { Cookie: gsisCookies } : {}),
    },
  });

  gsisCookies = mergeCookieJar(gsisCookies, parseSetCookieHeaders(r));

  const text = await r.text();

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: `GSIS proxy non-JSON (HTTP ${r.status})`, detail: text.slice(0, 400) };
  }

  if (json?.error?.code) {
    return { ok: false, error: `GSIS proxy HTTP ${json.error.code}`, detail: json.error };
  }

  if (!r.ok) {
    return { ok: false, error: `GSIS proxy HTTP ${r.status}`, detail: json };
  }

  return { ok: true, json };
}

function extractTzZone(attrs) {
  const tz = attrs?.TIMH ?? attrs?.CURRENTZONEVALUE ?? null;
  const zone_id = attrs?.ZONEREGISTRYID ?? null;
  const zone_name = attrs?.ZONENAME ?? null;

  return {
    tz_eur_sqm: tz != null ? Number(tz) : null,
    zone_id: zone_id != null ? String(zone_id) : null,
    zone_name: zone_name != null ? String(zone_name) : null,
  };
}

// -------------------- ROUTES --------------------
app.get("/health", (_, res) => res.json({ ok: true }));

// POST /lookup-zip {zip}
app.post("/lookup-zip", requireApiKey, async (req, res) => {
  try {
    let zip = String(req.body?.zip || "").replace(/\D+/g, "");
    if (zip.length !== 5) return res.status(400).json({ ok: false, error: "zip must be 5 digits" });

    const k = makeCacheKey({ type: "zip", zip });
    const hit = cacheGet(k);
    if (hit) return res.json({ ...hit, cached: true });

    const where = `ZONEREGISTRYID = ${zip} or UPPER(OIKISMOS) LIKE '%${zip}%'`;

    const params = new URLSearchParams({
      f: "json",
      where,
      returnGeometry: "false",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "ZONEREGISTRYID,ZONENAME,TIMH,CURRENTZONEVALUE,OBJECTID",
      outSR: "102100",
      resultRecordCount: "6",
    });

    const targetUrl = `${ZIP_LAYER_URL}?${params.toString()}`;
    const r = await gsisProxyJson(targetUrl);

    if (!r.ok) {
      cacheSet(k, r);
      return res.json({ ...r, cached: false });
    }

    const attrs = r.json?.features?.[0]?.attributes;
    if (!attrs) {
      const out = { ok: false, error: "No attributes returned" };
      cacheSet(k, out);
      return res.json({ ...out, cached: false });
    }

    const out = { ok: true, zip, ...extractTzZone(attrs) };
    cacheSet(k, out);
    return res.json({ ...out, cached: false });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// POST /lookup {lat,lng}
app.post("/lookup", requireApiKey, async (req, res) => {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ ok: false, error: "lat/lng required" });
    }

    const k = makeCacheKey({ type: "ll", lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
    const hit = cacheGet(k);
    if (hit) return res.json({ ...hit, cached: true });

    const params = new URLSearchParams({
      f: "json",
      where: "1=1",
      returnGeometry: "false",
      geometryType: "esriGeometryPoint",
      spatialRel: "esriSpatialRelIntersects",
      inSR: "4326",
      outSR: "4326",
      outFields: "ZONEREGISTRYID,ZONENAME,TIMH,CURRENTZONEVALUE",
      geometry: JSON.stringify({
        x: lng,
        y: lat,
        spatialReference: { wkid: 4326 },
      }),
    });

    const targetUrl = `${POINT_LAYER_URL}?${params.toString()}`;
    const r = await gsisProxyJson(targetUrl);

    if (!r.ok) {
      cacheSet(k, r);
      return res.json({ ...r, cached: false });
    }

    const attrs = r.json?.features?.[0]?.attributes;
    if (!attrs) {
      const out = { ok: false, error: "No attributes returned" };
      cacheSet(k, out);
      return res.json({ ...out, cached: false });
    }

    const out = { ok: true, ...extractTzZone(attrs) };
    cacheSet(k, out);
    return res.json({ ...out, cached: false });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log(`✅ GHF GSIS Lookup running on ${PORT}`));