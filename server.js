import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = Number(process.env.PORT || 3000);

/* ================= CORS (safe default) =================
   Even if you don't need CORS now (WP proxy), this won't hurt.
*/
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ================= API KEY ================= */
const API_KEY = process.env.API_KEY || "";
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // if not set, allow (not recommended)
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

/* ================= CACHE ================= */
const cache = new Map(); // key -> { ts, ttl, data }
const CACHE_TTL_DAYS = Number(process.env.CACHE_TTL_DAYS || 30);
const CACHE_OK_MS = 1000 * 60 * 60 * 24 * CACHE_TTL_DAYS;
const CACHE_FAIL_MS = 1000 * 60 * 10;

function cacheKey(lat, lng) {
  const a = lat.toFixed(5);
  const b = lng.toFixed(5);
  return crypto.createHash("md5").update(`${a},${b}`).digest("hex");
}
function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > item.ttl) {
    cache.delete(key);
    return null;
  }
  return item.data;
}

/* ================= GSIS ArcGIS endpoint =================
   This is the direct REST service the map uses.
*/
const ARCGIS_QUERY_URL =
  "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/1/query";

// Build ArcGIS query in WGS84 (EPSG:4326)
function buildArcGisUrl(lat, lng) {
  const geometry = {
    x: lng,
    y: lat,
    spatialReference: { wkid: 4326 }
  };

  const params = new URLSearchParams({
    f: "json",
    where: "1=1",
    returnGeometry: "false",
    spatialRel: "esriSpatialRelIntersects",
    geometry: JSON.stringify(geometry),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    outFields: "ZONENAME,CURRENTZONEVALUE,ZONEREGISTRYID,TIMH",
    outSR: "4326",
    // add a small tolerance (meters) to avoid edge misses
    distance: "5",
    units: "esriSRUnit_Meter"
  });

  return `${ARCGIS_QUERY_URL}?${params.toString()}`;
}

async function arcGisLookup(lat, lng) {
  const url = buildArcGisUrl(lat, lng);

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "GHF-GSIS-Lookup/1.0"
    }
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { ok: false, error: `ArcGIS HTTP ${resp.status}`, detail: text.slice(0, 200) };
  }

  const json = await resp.json().catch(() => null);
  const attrs = json?.features?.[0]?.attributes;

  if (!attrs) {
    return { ok: false, error: "No attributes returned" };
  }

  const tz = (attrs.TIMH ?? attrs.CURRENTZONEVALUE) ?? null;

  return {
    ok: true,
    zone_id: attrs.ZONEREGISTRYID ?? null,
    zone_name: attrs.ZONENAME ?? null,
    tz_eur_sqm: tz != null ? Number(tz) : null,
    raw: attrs
  };
}

/* ================= ROUTES ================= */
app.get("/", (_, res) => res.status(200).send("ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/lookup", requireApiKey, async (req, res) => {
  try {
    const { lat, lng } = req.body || {};
    const latNum = Number(lat);
    const lngNum = Number(lng);

    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return res.status(400).json({ ok: false, error: "lat/lng required" });
    }

    const key = cacheKey(latNum, lngNum);
    const cached = getCache(key);
    if (cached) return res.json({ ...cached, cached: true });

    const data = await arcGisLookup(latNum, lngNum);

    cache.set(key, {
      ts: Date.now(),
      ttl: data.ok ? CACHE_OK_MS : CACHE_FAIL_MS,
      data
    });

    return res.json({ ...data, cached: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ GHF GSIS Lookup running on port ${PORT}`);
});