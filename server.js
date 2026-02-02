import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;

/* -------------------- CORS -------------------- */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  // allow all if ALLOWED_ORIGINS is empty, otherwise only listed origins
  const allow =
    !origin ||
    allowedOrigins.length === 0 ||
    allowedOrigins.includes(origin);

  if (origin && allow) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* -------------------- API KEY -------------------- */
const API_KEY = process.env.API_KEY || "";
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // allow if not set (not recommended)
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

/* -------------------- Cache -------------------- */
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

/* -------------------- GSIS Proxy + Cookie Bootstrap --------------------
   The official map calls:
   https://maps.gsis.gr/valuemaps2/PHP/proxy.php?https://maps.gsis.gr/arcgis/rest/...
   and that proxy sets cookies (AGS_ROLES, maybe PHPSESSID).
   If you call the ArcGIS endpoint WITHOUT those cookies → you get 403.
----------------------------------------------------------------------- */

const GSIS_PROXY = "https://maps.gsis.gr/valuemaps2/PHP/proxy.php?";

// Keep the latest cookies here
let gsisCookie = "";
let gsisCookieTs = 0;
const GSIS_COOKIE_TTL_MS = 1000 * 60 * 45; // refresh ~ every 45 min

function proxiedUrl(targetUrl) {
  return `${GSIS_PROXY}${encodeURIComponent(targetUrl)}`;
}

// Node 20 fetch sometimes provides getSetCookie(); fallback to raw header.
function extractSetCookies(res) {
  const any = res.headers;
  // undici provides headers.getSetCookie()
  if (typeof any.getSetCookie === "function") {
    return any.getSetCookie();
  }
  const one = res.headers.get("set-cookie");
  return one ? [one] : [];
}

function buildCookieHeader(setCookies) {
  // Keep only "name=value" part from each Set-Cookie
  const pairs = [];
  for (const sc of setCookies || []) {
    const first = String(sc).split(";")[0].trim();
    if (first) pairs.push(first);
  }
  // Merge into a single Cookie header
  return pairs.join("; ");
}

async function ensureGsisCookie() {
  if (gsisCookie && Date.now() - gsisCookieTs < GSIS_COOKIE_TTL_MS) {
    return gsisCookie;
  }

  // A harmless call through proxy that will reliably set AGS_ROLES
  const warmTarget = "https://maps.gsis.gr/arcgis/rest/info?f=json";
  const warmUrl = proxiedUrl(warmTarget);

  const res = await fetch(warmUrl, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (GHF-GSIS-Lookup)",
      Referer: "https://maps.gsis.gr/valuemaps/",
    },
  });

  const setCookies = extractSetCookies(res);
  const cookie = buildCookieHeader(setCookies);

  // Even if response is not OK, cookie might still be set — store if present
  if (cookie) {
    gsisCookie = cookie;
    gsisCookieTs = Date.now();
  }

  return gsisCookie; // may be empty if GSIS changed behavior
}

async function fetchJsonViaGsisProxy(targetUrl) {
  const url = proxiedUrl(targetUrl);
  const cookie = await ensureGsisCookie();

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (GHF-GSIS-Lookup)",
      Referer: "https://maps.gsis.gr/valuemaps/",
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });

  // If GSIS rotated cookies, refresh once and retry
  if (res.status === 403) {
    gsisCookie = "";
    gsisCookieTs = 0;
    const cookie2 = await ensureGsisCookie();

    const retry = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (GHF-GSIS-Lookup)",
        Referer: "https://maps.gsis.gr/valuemaps/",
        ...(cookie2 ? { Cookie: cookie2 } : {}),
      },
    });

    return parseJsonResponse(retry);
  }

  return parseJsonResponse(res);
}

async function parseJsonResponse(res) {
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: `GSIS proxy non-JSON response (HTTP ${res.status})`,
      snippet: text.slice(0, 300),
    };
  }

  if (!res.ok) {
    return { ok: false, error: `GSIS proxy HTTP ${res.status}`, detail: json };
  }
  return { ok: true, json };
}

/* -------------------- LOOKUP LOGIC -------------------- */

// 2021 point-intersects layer (TZ + Zone ID)
const LAYER_POINT =
  "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/1/query";

// ArcGIS world geocode used by the official search bar (and works for ZIP)
const ARCGIS_GEOCODE =
  "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates";

async function geocodeZipToLatLng(zip) {
  const clean = String(zip).replace(/\D+/g, "");
  if (clean.length !== 5) return null;

  const u = new URL(ARCGIS_GEOCODE);
  u.searchParams.set("f", "json");
  u.searchParams.set("singleLine", clean);
  u.searchParams.set("maxLocations", "1");
  u.searchParams.set("outSR", "4326");
  u.searchParams.set("countryCode", "GRC");

  const res = await fetch(u.toString(), {
    headers: { Accept: "application/json" },
  });
  const json = await res.json();
  const c = json?.candidates?.[0];
  if (!c?.location) return null;

  // ArcGIS returns { x: lng, y: lat }
  return {
    lat: Number(c.location.y),
    lng: Number(c.location.x),
    address: c.address || null,
    score: Number(c.score || 0),
  };
}

async function lookupByLatLng(lat, lng) {
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

  const tz = attrs.TIMH ?? attrs.CURRENTZONEVALUE ?? null;

  return {
    ok: true,
    zone_id: attrs.ZONEREGISTRYID != null ? String(attrs.ZONEREGISTRYID) : null,
    zone_name: attrs.ZONENAME ?? null,
    tz_eur_sqm: tz != null ? Number(tz) : null,
  };
}

/* -------------------- ROUTES -------------------- */

app.get("/health", (_, res) => res.json({ ok: true }));

// lat/lng lookup
app.post("/lookup", requireApiKey, async (req, res) => {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ ok: false, error: "lat/lng required" });
    }

    const key = makeCacheKey({
      type: "ll",
      lat: +lat.toFixed(6),
      lng: +lng.toFixed(6),
    });

    const hit = cacheGet(key);
    if (hit) return res.json({ ...hit, cached: true });

    const out = await lookupByLatLng(lat, lng);
    cacheSet(key, out);
    return res.json({ ...out, cached: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ZIP lookup (geocode → lat/lng → lookup)
app.post("/lookup-zip", requireApiKey, async (req, res) => {
  try {
    const zip = String(req.body?.zip || "");
    const clean = zip.replace(/\D+/g, "");
    if (clean.length !== 5) {
      return res.status(400).json({ ok: false, error: "zip must be 5 digits" });
    }

    const key = makeCacheKey({ type: "zip", zip: clean });
    const hit = cacheGet(key);
    if (hit) return res.json({ ...hit, cached: true });

    const geo = await geocodeZipToLatLng(clean);
    if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lng)) {
      const out = { ok: false, error: "ZIP geocode failed", zip: clean };
      cacheSet(key, out);
      return res.json({ ...out, cached: false });
    }

    const outLL = await lookupByLatLng(geo.lat, geo.lng);
    const out = {
      ...outLL,
      zip: clean,
      geocode: { lat: geo.lat, lng: geo.lng, address: geo.address, score: geo.score },
    };

    cacheSet(key, out);
    return res.json({ ...out, cached: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log(`✅ GHF GSIS Lookup running on ${PORT}`));