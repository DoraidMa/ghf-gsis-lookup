import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;

// -------------------- CORS --------------------
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

// -------------------- API KEY --------------------
const API_KEY = process.env.API_KEY || "";
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // allow if not set (not recommended)
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

// -------------------- Cache --------------------
const cache = new Map();
const CACHE_TTL_DAYS = Number(process.env.CACHE_TTL_DAYS || 30);
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * CACHE_TTL_DAYS;

function cacheKey(obj) {
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

// -------------------- GSIS PROXY HELPERS --------------------
// GSIS proxy used by the official map:
const GSIS_PROXY = "https://maps.gsis.gr/valuemaps2/PHP/proxy.php?";

function proxiedUrl(targetUrl) {
  // targetUrl must be absolute
  return `${GSIS_PROXY}${encodeURIComponent(targetUrl)}`;
}

async function fetchJsonViaGsisProxy(targetUrl) {
  const url = proxiedUrl(targetUrl);
  const res = await fetch(url, {
    method: "GET",
    // Important: look like a browser a bit (some systems behave differently)
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (GHF-GSIS-Lookup)",
    },
  });

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: `GSIS proxy non-JSON response (HTTP ${res.status})`, raw: text.slice(0, 400) };
  }

  if (!res.ok) {
    return { ok: false, error: `GSIS proxy HTTP ${res.status}`, detail: json };
  }
  return { ok: true, json };
}

// -------------------- LOOKUP LOGIC --------------------
// Use the 2021 layer commonly used for point-intersects.
// (You can change layer ID if GSIS changes it, but keep proxy.php!)
const LAYER_POINT = "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/1/query";

async function lookupByLatLng(lat, lng) {
  // ArcGIS query (point intersects)
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
      x: Number(lng),
      y: Number(lat),
      spatialReference: { wkid: 4326 },
    }),
  });

  const targetUrl = `${LAYER_POINT}?${params.toString()}`;
  const r = await fetchJsonViaGsisProxy(targetUrl);
  if (!r.ok) return r;

  const attrs = r.json?.features?.[0]?.attributes;
  if (!attrs) return { ok: false, error: "No attributes returned" };

  const tz = (attrs.TIMH ?? attrs.CURRENTZONEVALUE);
  return {
    ok: true,
    zone_id: attrs.ZONEREGISTRYID != null ? String(attrs.ZONEREGISTRYID) : null,
    zone_name: attrs.ZONENAME ?? null,
    tz_eur_sqm: tz != null ? Number(tz) : null,
  };
}

// ZIP search the same way the UI does (example you captured was APAA_2018 layer).
const LAYER_ZIP = "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2018_INFO/MapServer/18/query";

async function lookupByZip(zip) {
  const clean = String(zip).replace(/\D+/g, "");
  if (clean.length !== 5) return { ok: false, error: "zip must be 5 digits" };

  // Matches what you saw in Network:
  // where = ZONEREGISTRYID = 10681 OR UPPER(OIKISMOS) LIKE '%10681%'
  const where = `ZONEREGISTRYID = ${clean} OR UPPER(OIKISMOS) LIKE '%${clean}%'`;

  const params = new URLSearchParams({
    f: "json",
    where,
    returnGeometry: "false",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "ZONEREGISTRYID,ZONENAME,CURRENTZONEVALUE,TIMH",
    outSR: "102100",
    resultRecordCount: "6",
  });

  const targetUrl = `${LAYER_ZIP}?${params.toString()}`;
  const r = await fetchJsonViaGsisProxy(targetUrl);
  if (!r.ok) return r;

  const attrs = r.json?.features?.[0]?.attributes;
  if (!attrs) return { ok: false, error: "No attributes returned" };

  const tz = (attrs.TIMH ?? attrs.CURRENTZONEVALUE);
  return {
    ok: true,
    zip: clean,
    zone_id: attrs.ZONEREGISTRYID != null ? String(attrs.ZONEREGISTRYID) : null,
    zone_name: attrs.ZONENAME ?? null,
    tz_eur_sqm: tz != null ? Number(tz) : null,
  };
}

// -------------------- ROUTES --------------------
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/lookup", requireApiKey, async (req, res) => {
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ ok: false, error: "lat/lng required" });
  }

  const key = cacheKey({ type: "ll", lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
  const hit = cacheGet(key);
  if (hit) return res.json({ ...hit, cached: true });

  const out = await lookupByLatLng(lat, lng);
  cacheSet(key, out);
  return res.json({ ...out, cached: false });
});

app.post("/lookup-zip", requireApiKey, async (req, res) => {
  const zip = String(req.body?.zip || "");
  const clean = zip.replace(/\D+/g, "");
  if (clean.length !== 5) return res.status(400).json({ ok: false, error: "zip must be 5 digits" });

  const key = cacheKey({ type: "zip", zip: clean });
  const hit = cacheGet(key);
  if (hit) return res.json({ ...hit, cached: true });

  const out = await lookupByZip(clean);
  cacheSet(key, out);
  return res.json({ ...out, cached: false });
});

app.listen(PORT, () => console.log(`✅ GHF GSIS Lookup running on ${PORT}`));