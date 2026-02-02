import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";

/* =========================
   CORS
========================= */
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

/* =========================
   API KEY
========================= */
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // allow if unset (dev only)
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

/* =========================
   CACHE
========================= */
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

/* =========================
   GSIS proxy.php (requires Referer)
========================= */
const GSIS_PROXY = "https://maps.gsis.gr/valuemaps2/PHP/proxy.php?";
const GSIS_REFERER = "https://maps.gsis.gr/valuemaps/";

// The polygon layer (id=1) from the pjson you successfully fetched
const GSIS_LAYER =
  "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/1";

function proxiedUrl(targetUrl) {
  return `${GSIS_PROXY}${encodeURIComponent(targetUrl)}`;
}

async function fetchJsonViaGsisProxy(targetUrl) {
  const url = proxiedUrl(targetUrl);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Referer: GSIS_REFERER, // ✅ CRITICAL (without this you get 403)
      "User-Agent": "Mozilla/5.0 (GHF-GSIS-Lookup)"
    }
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: `GSIS proxy non-JSON response (HTTP ${res.status})`, raw: text };
  }

  if (!res.ok || json?.error) {
    return { ok: false, error: `GSIS proxy HTTP ${res.status}`, detail: json };
  }

  return { ok: true, json };
}

/* =========================
   ArcGIS identify (lat/lng -> attributes)
========================= */
function identifyUrl(lat, lng) {
  // Provide a tiny extent + imageDisplay; ArcGIS identify expects these.
  const params = new URLSearchParams({
    f: "json",
    tolerance: "3",
    returnGeometry: "false",
    imageDisplay: "800,600,96",
    mapExtent: `${lng - 0.001},${lat - 0.001},${lng + 0.001},${lat + 0.001}`,
    geometryType: "esriGeometryPoint",
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    sr: "4326",
    layers: "all"
  });

  return `${GSIS_LAYER}/identify?${params.toString()}`;
}

async function lookupByLatLng(lat, lng) {
  const target = identifyUrl(lat, lng);
  const r = await fetchJsonViaGsisProxy(target);
  if (!r.ok) return r;

  const attrs = r.json?.results?.[0]?.attributes;
  if (!attrs) return { ok: false, error: "No attributes returned", debug: r.json };

  // Keep raw until we confirm exact field names in results
  const tz = attrs.TIMH ?? attrs.CURRENTZONEVALUE ?? attrs.ZONEVALUE ?? null;
  const zoneId = attrs.ZONEREGISTRYID ?? attrs.ZONEID ?? attrs.ID ?? null;
  const zoneName = attrs.ZONENAME ?? attrs.NAME ?? attrs.OIKISMOS ?? null;

  return {
    ok: true,
    tz_eur_sqm: tz != null ? Number(tz) : null,
    zone_id: zoneId != null ? String(zoneId) : null,
    zone_name: zoneName != null ? String(zoneName) : null,
    raw: attrs
  };
}

/* =========================
   ArcGIS World geocode (zip -> lat/lng)
========================= */
async function geocodeZip(zip) {
  const url =
    `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates` +
    `?f=json&singleLine=${encodeURIComponent(zip)}&countryCode=GRC&outSR=4326&maxLocations=1`;

  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const json = await res.json();

  const c = json?.candidates?.[0];
  if (!c) return null;

  return {
    lat: c.location.y,
    lng: c.location.x,
    address: c.address,
    score: c.score
  };
}

/* =========================
   ROUTES
========================= */
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/lookup", requireApiKey, async (req, res) => {
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ ok: false, error: "lat/lng required" });
  }

  const key = cacheKey({ t: "ll", lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
  const hit = cacheGet(key);
  if (hit) return res.json({ ...hit, cached: true });

  const out = await lookupByLatLng(lat, lng);
  cacheSet(key, out);
  return res.json({ ...out, cached: false });
});

app.post("/lookup-zip", requireApiKey, async (req, res) => {
  const zip = String(req.body?.zip || "").replace(/\D+/g, "");
  if (zip.length !== 5) return res.status(400).json({ ok: false, error: "zip must be 5 digits" });

  const key = cacheKey({ t: "zip", zip });
  const hit = cacheGet(key);
  if (hit) return res.json({ ...hit, cached: true });

  const geo = await geocodeZip(zip);
  if (!geo) {
    const out = { ok: false, error: "Zip geocode failed", zip };
    cacheSet(key, out);
    return res.json({ ...out, cached: false });
  }

  const out = await lookupByLatLng(geo.lat, geo.lng);
  const merged = { ...out, zip, geocode: geo };

  cacheSet(key, merged);
  return res.json({ ...merged, cached: false });
});

app.listen(PORT, () => console.log(`✅ GHF GSIS Lookup running on ${PORT}`));