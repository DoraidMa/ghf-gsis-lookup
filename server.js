import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || "";

// CORS (safe; WP proxy doesn’t need it, but fine)
app.use((req, res, next) => {
  const origin = req.headers.origin || "*";
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

// Cache (lat/lng rounded)
const cache = new Map();
const CACHE_OK_MS = 1000 * 60 * 60 * 24 * 30;
const CACHE_FAIL_MS = 1000 * 60 * 10;

function cacheKey(lat, lng) {
  const a = Number(lat).toFixed(6);
  const b = Number(lng).toFixed(6);
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

app.get("/", (_, res) => res.status(200).send("ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * GSIS Identify endpoint (this mimics clicking the polygon)
 * We use MapServer/identify with a tolerance to avoid boundary misses.
 */
async function gsisIdentify(lat, lng) {
  const identifyUrl =
    "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/identify";

  // Identify expects a “map context” too
  // These values don’t need to match a real screen; they just must be valid.
  const geometry = JSON.stringify({
    x: Number(lng),
    y: Number(lat),
    spatialReference: { wkid: 4326 }
  });

  const params = new URLSearchParams({
    f: "json",
    geometry,
    geometryType: "esriGeometryPoint",
    sr: "4326",
    tolerance: "10",              // meters-ish tolerance
    returnGeometry: "false",
    layers: "all:1",              // layer 1 from your earlier attempts
    mapExtent: "-180,-90,180,90", // global extent (valid)
    imageDisplay: "800,600,96"    // arbitrary valid display
  });

  const resp = await fetch(`${identifyUrl}?${params.toString()}`, {
    headers: { Accept: "application/json" }
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    return { ok: false, error: `GSIS identify HTTP ${resp.status}`, detail: txt.slice(0, 200) };
  }

  const json = await resp.json().catch(() => null);

  // Identify response can be in results[]
  const attrs = json?.results?.[0]?.attributes;
  if (!attrs) return { ok: false, error: "No attributes returned" };

  const tz = (attrs.TIMH ?? attrs.CURRENTZONEVALUE) ?? null;

  return {
    ok: true,
    tz_eur_sqm: tz != null ? Number(tz) : null,
    zone_id: attrs.ZONEREGISTRYID != null ? String(attrs.ZONEREGISTRYID) : null,
    zone_name: attrs.ZONENAME != null ? String(attrs.ZONENAME) : null,
    raw: attrs
  };
}

/**
 * POST /lookup
 * body: { lat: 37.98, lng: 23.72 }
 */
app.post("/lookup", requireApiKey, async (req, res) => {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ ok: false, error: "lat/lng required" });
    }

    const key = cacheKey(lat, lng);
    const cached = getCache(key);
    if (cached) return res.json({ ...cached, cached: true });

    const data = await gsisIdentify(lat, lng);

    cache.set(key, { ts: Date.now(), ttl: data.ok ? CACHE_OK_MS : CACHE_FAIL_MS, data });

    return res.json({ ...data, cached: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ GHF GSIS Identify service running on port ${PORT}`);
});