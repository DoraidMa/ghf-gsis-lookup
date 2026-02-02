import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;

// ===================== CORS =====================
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

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

// ===================== API KEY =====================
const API_KEY = process.env.API_KEY || "";
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

// ===================== CACHE =====================
const cache = new Map();
const OK_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const FAIL_TTL_MS = 1000 * 60 * 2;          // 2 minutes

function makeCacheKey(obj) {
  return crypto.createHash("md5").update(JSON.stringify(obj)).digest("hex");
}
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > hit.ttl) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}
function cacheSet(key, data, ttl) {
  cache.set(key, { ts: Date.now(), ttl, data });
}

// ===================== GSIS PROXY =====================
// Your successful curl proved: proxy requires Referer header.
// We keep it consistent with your working terminal test.
const GSIS_PROXY = "https://maps.gsis.gr/valuemaps2/PHP/proxy.php?";

// Minimal cookie jar (in-memory)
let gsisCookies = "";
let lastWarmTs = 0;
const WARM_TTL_MS = 1000 * 60 * 10;

// Node 20 supports getSetCookie() in undici; fallback to set-cookie header.
function getSetCookies(res) {
  const sc = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const fallback = res.headers.get("set-cookie");
  return fallback ? sc.concat([fallback]) : sc;
}

function mergeCookies(existing, setCookies) {
  const jar = new Map();

  // load existing
  (existing || "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean)
    .forEach((kv) => {
      const i = kv.indexOf("=");
      if (i === -1) return;
      jar.set(kv.slice(0, i), kv.slice(i + 1));
    });

  // add new
  for (const c of setCookies || []) {
    // Sometimes multiple cookie strings come together; split carefully by newline first
    const lines = String(c).split("\n");
    for (const line of lines) {
      const first = line.split(";")[0].trim();
      const i = first.indexOf("=");
      if (i === -1) continue;
      jar.set(first.slice(0, i), first.slice(i + 1));
    }
  }

  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

function browserHeaders() {
  return {
    "Accept": "application/json,text/plain,*/*",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
    "Referer": "https://maps.gsis.gr/valuemaps/",
    "Origin": "https://maps.gsis.gr",
  };
}

async function warmUpGsisSession() {
  if (Date.now() - lastWarmTs < WARM_TTL_MS && gsisCookies) return;

  // 1) Load the app (sets baseline cookies)
  try {
    const r1 = await fetch("https://maps.gsis.gr/valuemaps/", {
      method: "GET",
      headers: {
        ...browserHeaders(),
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    gsisCookies = mergeCookies(gsisCookies, getSetCookies(r1));
    await r1.text();
  } catch {
    // ignore
  }

  // 2) Hit proxy with harmless ArcGIS info to trigger AGS_ROLES etc.
  try {
    const warmTarget = "https://maps.gsis.gr/arcgis/rest/info?f=json";
    const r2 = await fetch(`${GSIS_PROXY}${warmTarget}`, {
      method: "GET",
      headers: {
        ...browserHeaders(),
        ...(gsisCookies ? { Cookie: gsisCookies } : {}),
      },
    });
    gsisCookies = mergeCookies(gsisCookies, getSetCookies(r2));
    await r2.text();
  } catch {
    // ignore
  }

  lastWarmTs = Date.now();
}

async function fetchJsonViaGsisProxy(targetUrl) {
  await warmUpGsisSession();

  // IMPORTANT: official browser request is proxy.php?https://... (raw URL)
  const url = `${GSIS_PROXY}${targetUrl}`;

  const r = await fetch(url, {
    method: "GET",
    headers: {
      ...browserHeaders(),
      ...(gsisCookies ? { Cookie: gsisCookies } : {}),
    },
  });

  gsisCookies = mergeCookies(gsisCookies, getSetCookies(r));

  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: `GSIS proxy non-JSON (HTTP ${r.status})`, snippet: text.slice(0, 300) };
  }

  // ArcGIS may return {error:{code,...}} even if HTTP 200
  if (json?.error?.code) {
    return { ok: false, error: `ArcGIS error ${json.error.code}`, detail: json.error };
  }

  if (!r.ok) {
    return { ok: false, error: `GSIS proxy HTTP ${r.status}`, detail: json };
  }

  return { ok: true, json };
}

// ===================== SERVICE + LAYER =====================
// You discovered layers:
// 0 = ΓΡΑΜΜΙΚΕΣ ΖΩΝΕΣ (polyline)
// 1 = ΚΥΚΛΙΚΕΣ ΖΩΝΕΣ (polygon)  <-- we need this one

const SERVICE_2021 = "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer";
const ZONE_LAYER_ID = 1; // ✅ ΚΥΚΛΙΚΕΣ ΖΩΝΕΣ (polygon)
const LAYER_QUERY = `${SERVICE_2021}/${ZONE_LAYER_ID}/query`;

// ===================== LOOKUP BY POINT =====================
async function lookupByLatLng(lat, lng) {
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return { ok: false, error: "Invalid lat/lng" };
  }

  const params = new URLSearchParams({
    f: "json",
    where: "1=1",
    returnGeometry: "false",
    geometryType: "esriGeometryPoint",
    spatialRel: "esriSpatialRelIntersects",
    inSR: "4326",
    outSR: "102100",
    outFields: "ZONEREGISTRYID,ZONENAME,TIMH,CURRENTZONEVALUE",
    geometry: JSON.stringify({
      x: lngNum,
      y: latNum,
      spatialReference: { wkid: 4326 },
    }),
  });

  const r = await fetchJsonViaGsisProxy(`${LAYER_QUERY}?${params.toString()}`);
  if (!r.ok) return r;

  const attrs = r.json?.features?.[0]?.attributes;
  if (!attrs) return { ok: false, error: "No attributes returned", debug: r.json };

  const tz = attrs.TIMH ?? attrs.CURRENTZONEVALUE ?? null;

  return {
    ok: true,
    zone_id: attrs.ZONEREGISTRYID != null ? String(attrs.ZONEREGISTRYID) : null,
    zone_name: attrs.ZONENAME ?? null,
    tz_eur_sqm: tz != null ? Number(tz) : null,
  };
}

// ===================== ZIP -> GEOCODE -> LOOKUP =====================
async function geocodeZip(zip) {
  const clean = String(zip || "").replace(/\D+/g, "");
  if (clean.length !== 5) return null;

  const url = new URL("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates");
  url.searchParams.set("f", "json");
  url.searchParams.set("singleLine", clean);
  url.searchParams.set("maxLocations", "1");
  url.searchParams.set("outSR", "4326");
  url.searchParams.set("countryCode", "GRC");

  const res = await fetch(url.toString(), { headers: { Accept: "application/json" } });
  const json = await res.json();

  const c = json?.candidates?.[0];
  const lat = c?.location?.y;
  const lng = c?.location?.x;
  const score = c?.score ?? 0;

  if (!Number.isFinite(lat) || !Number.isFinite(lng) || score < 90) return null;
  return { lat, lng, address: c?.address ?? null, score };
}

// ===================== ROUTES =====================
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/lookup", requireApiKey, async (req, res) => {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);

    const key = makeCacheKey({ t: "ll", lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
    const hit = cacheGet(key);
    if (hit) return res.json({ ...hit, cached: true });

    const out = await lookupByLatLng(lat, lng);

    // Cache only success long; failures short
    cacheSet(key, out, out.ok ? OK_TTL_MS : FAIL_TTL_MS);

    return res.json({ ...out, cached: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/lookup-zip", requireApiKey, async (req, res) => {
  try {
    const zip = String(req.body?.zip || "");
    const clean = zip.replace(/\D+/g, "");
    if (clean.length !== 5) return res.status(400).json({ ok: false, error: "zip must be 5 digits" });

    const key = makeCacheKey({ t: "zip", zip: clean });
    const hit = cacheGet(key);
    if (hit) return res.json({ ...hit, cached: true });

    const geo = await geocodeZip(clean);
    if (!geo) {
      const out = { ok: false, error: "ZIP geocode failed", zip: clean };
      cacheSet(key, out, FAIL_TTL_MS);
      return res.json({ ...out, cached: false });
    }

    const outLL = await lookupByLatLng(geo.lat, geo.lng);
    const out = { ...outLL, zip: clean, geocode: geo };

    cacheSet(key, out, out.ok ? OK_TTL_MS : FAIL_TTL_MS);

    return res.json({ ...out, cached: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log(`✅ GHF GSIS Lookup running on ${PORT}`));