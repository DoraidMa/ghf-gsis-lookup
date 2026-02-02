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
  if (!API_KEY) return next(); // dev-only
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
   GSIS PROXY + SESSION
========================= */
const GSIS_PROXY = "https://maps.gsis.gr/valuemaps2/PHP/proxy.php?";
const GSIS_REFERER = "https://maps.gsis.gr/valuemaps/";
const GSIS_WARMUP_URL = "https://maps.gsis.gr/valuemaps/";

// 2021 service (from your successful pjson)
const GSIS_MAPSERVER = "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer";
const GSIS_LAYER_POLYGONS = `${GSIS_MAPSERVER}/1`; // ΚΥΚΛΙΚΕΣ ΖΩΝΕΣ (polygon)

// Simple in-memory cookie jar (good enough for one Railway instance)
let gsisCookieHeader = "";

// Parse and merge Set-Cookie headers into a single Cookie header string
function mergeSetCookie(existingCookieHeader, setCookieHeaders) {
  if (!setCookieHeaders) return existingCookieHeader;

  const jar = new Map();

  // load existing
  if (existingCookieHeader) {
    existingCookieHeader.split(";").forEach((pair) => {
      const p = pair.trim();
      if (!p) return;
      const idx = p.indexOf("=");
      if (idx === -1) return;
      jar.set(p.slice(0, idx), p.slice(idx + 1));
    });
  }

  // apply new
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const sc of arr) {
    const first = String(sc).split(";")[0].trim(); // "NAME=value"
    const idx = first.indexOf("=");
    if (idx === -1) continue;
    jar.set(first.slice(0, idx), first.slice(idx + 1));
  }

  // rebuild
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function warmUpGsisSession() {
  // If we already have something, don’t spam warmups
  if (gsisCookieHeader) return;

  const res = await fetch(GSIS_WARMUP_URL, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (GHF-GSIS-Lookup)",
      Referer: GSIS_REFERER
    }
  });

  // Node fetch exposes set-cookie via headers.getSetCookie() in Node 20+
  const setCookies = res.headers.getSetCookie?.() || res.headers.get("set-cookie");
  gsisCookieHeader = mergeSetCookie(gsisCookieHeader, setCookies);
}

function proxiedUrl(targetUrl) {
  return `${GSIS_PROXY}${encodeURIComponent(targetUrl)}`;
}

async function fetchJsonViaGsisProxy(targetUrl) {
  await warmUpGsisSession();

  const url = proxiedUrl(targetUrl);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Referer: GSIS_REFERER,
      "User-Agent": "Mozilla/5.0 (GHF-GSIS-Lookup)",
      ...(gsisCookieHeader ? { Cookie: gsisCookieHeader } : {})
    }
  });

  const setCookies = res.headers.getSetCookie?.() || res.headers.get("set-cookie");
  gsisCookieHeader = mergeSetCookie(gsisCookieHeader, setCookies);

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: `Non-JSON from GSIS proxy (HTTP ${res.status})`, raw: text };
  }

  if (!res.ok || json?.error) {
    return { ok: false, error: `GSIS proxy HTTP ${res.status}`, detail: json };
  }

  return { ok: true, json };
}

/* =========================
   LOOKUP (lat/lng -> polygon query)
========================= */
async function lookupByLatLng(lat, lng) {
  // Use the layer query endpoint (NOT pjson, NOT identify)
  const params = new URLSearchParams({
    f: "json",
    where: "1=1",
    returnGeometry: "false",
    geometryType: "esriGeometryPoint",
    spatialRel: "esriSpatialRelIntersects",
    inSR: "4326",
    outSR: "4326",
    outFields: "ZONEREGISTRYID,ZONENAME,CURRENTZONEVALUE",
    geometry: JSON.stringify({
      x: Number(lng),
      y: Number(lat),
      spatialReference: { wkid: 4326 }
    })
  });

  const targetUrl = `${GSIS_LAYER_POLYGONS}/query?${params.toString()}`;
  const r = await fetchJsonViaGsisProxy(targetUrl);
  if (!r.ok) return r;

  const attrs = r.json?.features?.[0]?.attributes;
  if (!attrs) {
    return { ok: false, error: "No attributes returned", debug: r.json };
  }

  const tz = attrs.CURRENTZONEVALUE ?? null;

  return {
    ok: true,
    zone_id: attrs.ZONEREGISTRYID != null ? String(attrs.ZONEREGISTRYID) : null,
    zone_name: attrs.ZONENAME ?? null,
    tz_eur_sqm: tz != null ? Number(tz) : null
  };
}

/* =========================
   ZIP -> geocode (ArcGIS World) -> lat/lng -> lookup
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























  






































21_INFO/MapServer/1";


















us})`, raw: text };


};















 } }),










son };

















AddressCandidates` +
&maxLocations=1`;





















});








must be 5 digits" });














