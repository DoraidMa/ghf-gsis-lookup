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
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

// -------------------- Cache (OK long, FAIL short) --------------------
const cache = new Map();
const OK_TTL_MS = 1000 * 60 * 60 * 24 * 30;  // 30 days
const FAIL_TTL_MS = 1000 * 60 * 2;           // 2 minutes

function cacheKey(obj) {
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

// -------------------- GSIS Proxy --------------------
// Your captured browser request is: proxy.php?https://maps.gsis.gr/arcgis/rest/...
// So we do NOT encode the full URL after the "?"
const GSIS_PROXY = "https://maps.gsis.gr/valuemaps2/PHP/proxy.php?";

async function fetchJsonViaGsisProxy(targetUrl) {
  const url = `${GSIS_PROXY}${targetUrl}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (GHF-GSIS-Lookup)",
      Referer: "https://maps.gsis.gr/valuemaps/",
      Origin: "https://maps.gsis.gr",
    },
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: `GSIS non-JSON (HTTP ${res.status})`, snippet: text.slice(0, 300) };
  }

  // ArcGIS may return {error:{code,...}} even with HTTP 200
  if (json?.error?.code) {
    return { ok: false, error: `ArcGIS error ${json.error.code}`, detail: json.error };
  }

  if (!res.ok) {
    return { ok: false, error: `GSIS HTTP ${res.status}`, detail: json };
  }

  return { ok: true, json };
}

// -------------------- Geometry --------------------
// WGS84 -> WebMercator (EPSG:3857 / wkid 102100)
function toWebMercator(lat, lng) {
  const x = (lng * 20037508.34) / 180.0;
  let y =
    Math.log(Math.tan(((90.0 + lat) * Math.PI) / 360.0)) / (Math.PI / 180.0);
  y = (y * 20037508.34) / 180.0;
  return { x, y };
}

// -------------------- ArcGIS Geocoder (ZIP -> point) --------------------
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

// -------------------- GSIS layer query (THIS WAS THE BUG) --------------------
const LAYER_POINT =
  "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/1/query";

async function lookupByLatLng(lat, lng) {
  // Use WebMercator for this layer
  const { x, y } = toWebMercator(Number(lat), Number(lng));

  const params = new URLSearchParams({
    f: "json",
    where: "1=1",
    returnGeometry: "false",
    geometryType: "esriGeometryPoint",
    spatialRel: "esriSpatialRelIntersects",
    inSR: "102100",
    outSR: "102100",
    outFields: "ZONEREGISTRYID,ZONENAME,TIMH,CURRENTZONEVALUE",
    geometry: JSON.stringify({
      x,
      y,
      spatialReference: { wkid: 102100 },
    }),
    distance: "0.01",
    units: "esriSRUnit_Meter",
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

// -------------------- Routes --------------------
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/lookup", requireApiKey, async (req, res) => {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ ok: false, error: "lat/lng required" });
    }

    const key = cacheKey({ t: "ll", lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
    const hit = cacheGet(key);
    if (hit) return res.json({ ...hit, cached: true });

    const out = await lookupByLatLng(lat, lng);
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
    if (clean.length !== 5) {
      return res.status(400).json({ ok: false, error: "zip must be 5 digits" });
    }

    const key = cacheKey({ t: "zip", zip: clean });
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