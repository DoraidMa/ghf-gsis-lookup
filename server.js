import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;

// =====================
// CORS
// =====================
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

// =====================
// API KEY
// =====================
const API_KEY = process.env.API_KEY || "";
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // allow if not set (not recommended)
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

// =====================
// Cache
// =====================
const cache = new Map();
const CACHE_TTL_DAYS = Number(process.env.CACHE_TTL_DAYS || 30);
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * CACHE_TTL_DAYS;

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

// =====================
// GSIS Proxy (IMPORTANT)
// =====================
// Official map uses:
// https://maps.gsis.gr/valuemaps2/PHP/proxy.php?https://maps.gsis.gr/arcgis/rest/...
//
// DO NOT encode the target URL.
// Keep cookies between calls.
const GSIS_PROXY = "https://maps.gsis.gr/valuemaps2/PHP/proxy.php?";

// minimal cookie jar (per instance)
let gsisCookies = "";

function updateCookiesFromResponse(res) {
  // Node fetch exposes set-cookie; may contain multiple cookies in one string.
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) return;

  // Keep only cookie pairs (before ';') and merge
  const parts = setCookie
    .split(",") // crude split; OK for GSIS cookies
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean);

  const existing = new Set(
    gsisCookies
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean)
  );

  for (const p of parts) existing.add(p);
  gsisCookies = Array.from(existing).join("; ");
}

async function fetchJsonViaGsisProxy(targetUrl) {
  // IMPORTANT: no encodeURIComponent here
  const url = `${GSIS_PROXY}${targetUrl}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (GHF-GSIS-Lookup)",
      Referer: "https://maps.gsis.gr/valuemaps/",
      Origin: "https://maps.gsis.gr",
      ...(gsisCookies ? { Cookie: gsisCookies } : {}),
    },
  });

  updateCookiesFromResponse(res);

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: `GSIS proxy non-JSON response (HTTP ${res.status})`,
      snippet: text.slice(0, 200),
    };
  }

  if (!res.ok) {
    return { ok: false, error: `GSIS proxy HTTP ${res.status}`, detail: json };
  }

  return { ok: true, json };
}

// =====================
// Layer URLs (based on your capture)
// =====================

// ZIP search you captured (works in browser):
// .../PUBLIC_ZONES_APAA_2018_INFO/MapServer/18/query
const ZIP_LAYER_QUERY =
  "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2018_INFO/MapServer/18/query";

// Lat/Lng point-intersects (older working pattern)
const POINT_LAYER_QUERY =
  "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/1/query";

// =====================
// Lookup functions
// =====================

function normalizeZip(zip) {
  return String(zip || "").replace(/\D+/g, "");
}

async function lookupByZip(zip) {
  const clean = normalizeZip(zip);
  if (clean.length !== 5) return { ok: false, error: "zip must be 5 digits" };

  // EXACT style you captured:
  // ZONEREGISTRYID = 10681 or UPPER(OIKISMOS) LIKE '%10681%'
  const where = `ZONEREGISTRYID = ${clean} or UPPER(OIKISMOS) LIKE '%${clean}%'`;

  // Step 1: get OBJECTID + ZONENAME (like the official request)
  const p1 = new URLSearchParams({
    f: "json",
    where,
    returnGeometry: "false",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "ZONENAME,OBJECTID",
    outSR: "102100",
    resultRecordCount: "6",
  });

  const r1 = await fetchJsonViaGsisProxy(`${ZIP_LAYER_QUERY}?${p1.toString()}`);
  if (!r1.ok) return r1;

  const attrs1 = r1.json?.features?.[0]?.attributes;
  if (!attrs1 || attrs1.OBJECTID == null) {
    return { ok: false, error: "No attributes returned", zip: clean };
  }

  const objectId = Number(attrs1.OBJECTID);
  if (!Number.isFinite(objectId)) {
    return { ok: false, error: "Invalid OBJECTID returned", zip: clean, attrs: attrs1 };
  }

  // Step 2: query same layer by OBJECTID to get price + zone id
  const p2 = new URLSearchParams({
    f: "json",
    where: `OBJECTID = ${objectId}`,
    returnGeometry: "false",
    outFields: "ZONEREGISTRYID,ZONENAME,CURRENTZONEVALUE,TIMH,OBJECTID",
    outSR: "102100",
    resultRecordCount: "1",
  });

  const r2 = await fetchJsonViaGsisProxy(`${ZIP_LAYER_QUERY}?${p2.toString()}`);
  if (!r2.ok) return r2;

  const attrs2 = r2.json?.features?.[0]?.attributes;
  if (!attrs2) {
    // fallback: at least return what we got
    return {
      ok: true,
      zip: clean,
      zone_name: attrs1.ZONENAME ?? null,
      object_id: String(objectId),
      tz_eur_sqm: null,
      zone_id: null,
      note: "Found zone name + object id, but no detail attributes returned",
    };
  }

  const tz = attrs2.TIMH ?? attrs2.CURRENTZONEVALUE ?? null;

  return {
    ok: true,
    zip: clean,
    zone_id: attrs2.ZONEREGISTRYID != null ? String(attrs2.ZONEREGISTRYID) : null,
    zone_name: attrs2.ZONENAME ?? attrs1.ZONENAME ?? null,
    tz_eur_sqm: tz != null ? Number(tz) : null,
    object_id: attrs2.OBJECTID != null ? String(attrs2.OBJECTID) : String(objectId),
  };
}

async function lookupByLatLng(lat, lng) {
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return { ok: false, error: "lat/lng required" };
  }

  const params = new URLSearchParams({
    f: "json",
    where: "1=1",
    returnGeometry: "false",
    geometryType: "esriGeometryPoint",
    spatialRel: "esriSpatialRelIntersects",
    inSR: "4326",
    outSR: "4326",
    outFields: "ZONEREGISTRYID,ZONENAME,CURRENTZONEVALUE,TIMH",
    geometry: JSON.stringify({
      x: lngNum,
      y: latNum,
      spatialReference: { wkid: 4326 },
    }),
  });

  const r = await fetchJsonViaGsisProxy(`${POINT_LAYER_QUERY}?${params.toString()}`);
  if (!r.ok) return r;

  const attrs = r.json?.features?.[0]?.attributes;
  if (!attrs) return { ok: false, error: "No attributes returned" };

  const tz = attrs.TIMH ?? attrs.CURRENTZONEVALUE ?? null;

  return {
    ok: true,
    zone_id: attrs.ZONEREGISTRYID != null ? String(attrs.ZONEREGISTRYID) : null,
    zone_name: attrs.ZONENAME ?? null,
    tz_eur_sqm: tz != null ? Number(tz) : null,
  };
}

// =====================
// Routes
// =====================
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/lookup", requireApiKey, async (req, res) => {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);

    const key = makeCacheKey({ type: "ll", lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
    const hit = cacheGet(key);
    if (hit) return res.json({ ...hit, cached: true });

    const out = await lookupByLatLng(lat, lng);
    cacheSet(key, out);
    return res.json({ ...out, cached: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.post("/lookup-zip", requireApiKey, async (req, res) => {
  try {
    const zip = String(req.body?.zip || "");
    const clean = normalizeZip(zip);
    if (clean.length !== 5) return res.status(400).json({ ok: false, error: "zip must be 5 digits" });

    const key = makeCacheKey({ type: "zip", zip: clean });
    const hit = cacheGet(key);
    if (hit) return res.json({ ...hit, cached: true });

    const out = await lookupByZip(clean);
    cacheSet(key, out);
    return res.json({ ...out, cached: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log(`✅ GHF GSIS Lookup running on ${PORT}`));