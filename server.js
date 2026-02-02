import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";

/* =========================
   CORS
========================= */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
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
   API KEY GUARD
========================= */
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // allow if unset (dev only)
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

/* =========================
   CACHE
========================= */
const cache = new Map();
const TTL_MS = 1000 * 60 * 60 * 24 * 30;

function cacheKey(obj) {
  return crypto.createHash("md5").update(JSON.stringify(obj)).digest("hex");
}
function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.data;
}
function cacheSet(key, data) {
  cache.set(key, { ts: Date.now(), data });
}

/* =========================
   GSIS CONSTANTS
========================= */

// MUST go through proxy.php
const GSIS_PROXY = "https://maps.gsis.gr/valuemaps2/PHP/proxy.php?";

// Layer used by the official map (polygon zones)
const GSIS_LAYER =
  "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/1";

// Identify endpoint
function identifyUrl(lat, lng) {
  const params = new URLSearchParams({
    f: "json",
    tolerance: "1",
    returnGeometry: "false",
    imageDisplay: "800,600,96",
    mapExtent: `${lng - 0.001},${lat - 0.001},${lng + 0.001},${lat + 0.001}`,
    geometryType: "esriGeometryPoint",
    geometry: JSON.stringify({
      x: lng,
      y: lat,
      spatialReference: { wkid: 4326 }
    }),
    sr: "4326",
    layers: "all"
  });

  return `${GSIS_LAYER}/identify?${params.toString()}`;
}

async function fetchViaGsisProxy(targetUrl) {
  const url = GSIS_PROXY + encodeURIComponent(targetUrl);

  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      // 🔴 THIS HEADER IS CRITICAL
      "Referer": "https://maps.gsis.gr/valuemaps/",
      "User-Agent": "Mozilla/5.0 (GHF-GSIS)"
    }
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "Non-JSON response", raw: text };
  }

  if (!res.ok || json.error) {
    return {
      ok: false,
      error: `ArcGIS error ${res.status}`,
      detail: json
    };
  }

  return { ok: true, json };
}

/* =========================
   LOOKUP BY LAT/LNG
========================= */
async function lookupByLatLng(lat, lng) {
  const target = identifyUrl(lat, lng);
  const r = await fetchViaGsisProxy(target);
  if (!r.ok) return r;

  const attrs = r.json?.results?.[0]?.attributes;
  if (!attrs) {
    return { ok: false, error: "No attributes returned", debug: r.json };
  }

  // TEMP: return raw so we can see exact field names
  const tz =
    attrs.TIMH ??
    attrs.CURRENTZONEVALUE ??
    attrs.ZONEVALUE ??
    null;

  const zoneId =
    attrs.ZONEREGISTRYID ??
    attrs.ZONEID ??
    attrs.ID ??
    null;

  const zoneName =
    attrs.ZONENAME ??
    attrs.NAME ??
    attrs.OIKISMOS ??
    null;

  return {
    ok: true,
    tz_eur_sqm: tz != null ? Number(tz) : null,
    zone_id: zoneId != null ? String(zoneId) : null,
    zone_name: zoneName != null ? String(zoneName) : null,
    raw: attrs // 🔍 IMPORTANT
  };
}

/* =========================
   ZIP → GEOCODE → IDENTIFY
========================= */
async function geocodeZip(zip) {
  const url =
    `https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates` +
    `?f=json&singleLine=${encodeURIComponent(zip)}&countryCode=GRC&outSR=4326&maxLocations=1`;

  const res = await fetch(url);
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

  const key = cacheKey({ t: "ll", lat: lat.toFixed(6), lng: lng.toFixed(6) });
  const hit = cacheGet(key);
  if (hit) return res.json({ ...hit, cached: true });

  const out = await lookupByLatLng(lat, lng);
  cacheSet(key, out);
  res.json({ ...out, cached: false });
});

app.post("/lookup-zip", requireApiKey, async (req, res) => {
  const zip = String(req.body?.zip || "").replace(/\D+/g, "");
  if (zip.length !== 5) {
    return res.status(400).json({ ok: false, error: "zip must be 5 digits" });
  }

  const key = cacheKey({ t: "zip", zip });
  const hit = cacheGet(key);
  if (hit) return res.json({ ...hit, cached: true });

  const geo = await geocodeZip(zip);
  if (!geo) {
    return res.json({ ok: false, error: "Zip geocode failed" });
  }

  const out = await lookupByLatLng(geo.lat, geo.lng);
  cacheSet(key, { ...out, zip, geocode: geo });
  res.json({ ...out, zip, geocode: geo, cached: false });
});

app.listen(PORT, () => {
  console.log(`✅ GHF GSIS Lookup running on port ${PORT}`);
});