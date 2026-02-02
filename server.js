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
// IMPORTANT: In your terminal test, proxy works only with Referer.
const GSIS_PROXY = "https://maps.gsis.gr/valuemaps2/PHP/proxy.php?";

function browserHeaders() {
  return {
    Accept: "application/json,text/plain,*/*",
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
    Referer: "https://maps.gsis.gr/valuemaps/",
    Origin: "https://maps.gsis.gr",
  };
}

async function fetchJsonViaGsisProxy(targetUrl) {
  // IMPORTANT: must be raw URL after '?', not encoded
  const url = `${GSIS_PROXY}${targetUrl}`;

  const r = await fetch(url, {
    method: "GET",
    headers: browserHeaders(),
  });

  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: `GSIS non-JSON (HTTP ${r.status})`, snippet: text.slice(0, 300) };
  }

  // ArcGIS returns {error:{code,...}} even with HTTP 200 sometimes
  if (json?.error?.code) {
    return { ok: false, error: `ArcGIS error ${json.error.code}`, detail: json.error };
  }

  if (!r.ok) {
    return { ok: false, error: `GSIS HTTP ${r.status}`, detail: json };
  }

  return { ok: true, json };
}

// ===================== GEOMETRY =====================
// WGS84 -> WebMercator (wkid 102100 / EPSG:3857)
function toWebMercator(lat, lng) {
  const x = (lng * 20037508.34) / 180.0;
  let y = Math.log(Math.tan(((90.0 + lat) * Math.PI) / 360.0)) / (Math.PI / 180.0);
  y = (y * 20037508.34) / 180.0;
  return { x, y };
}

// ===================== SERVICE / LAYER =====================
// From your successful pjson: layer 1 is "ΚΥΚΛΙΚΕΣ ΖΩΝΕΣ" (polygon)
const SERVICE_2021 =
  "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer";

const ZONE_LAYER_ID = 1;
const LAYER_QUERY = `${SERVICE_2021}/${ZONE_LAYER_ID}/query`;

// ===================== LOOKUPS =====================
async function lookupByLatLng(lat, lng) {
  const latNum = Number(lat);
  const lngNum = Number(lng);
  if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
    return { ok: false, error: "Invalid lat/lng" };
  }

  // ✅ This service is wkid 102100 — use WebMercator geometry
  const { x, y } = toWebMercator(latNum, lngNum);

  const params = new URLSearchParams({
    f: "json",
    where: "1=1",
    returnGeometry: "false",
    spatialRel: "esriSpatialRelIntersects",
    geometryType: "esriGeometryPoint",
    inSR: "102100",
    outSR: "102100",
    outFields: "ZONEREGISTRYID,ZONENAME,TIMH,CURRENTZONEVALUE",
    geometry: JSON.stringify({
      x,
      y,
      spatialReference: { wkid: 102100 }
    }),
    // small tolerance helps
    distance: "0.01",
    units: "esriSRUnit_Meter",
  });

  const targetUrl = `${LAYER_QUERY}?${params.toString()}`;
  const r = await fetchJsonViaGsisProxy(targetUrl);
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

// ZIP -> ArcGIS geocode -> lat/lng -> lookupByLatLng
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
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ ok: false, error: "lat/lng required" });
    }

    const key = makeCacheKey({ t: "ll", lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
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