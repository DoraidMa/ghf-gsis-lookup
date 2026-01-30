import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || "";

// CORS (safe default)
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

// cache
const cache = new Map();
const CACHE_OK_MS = 1000 * 60 * 60 * 24 * 30;
const CACHE_FAIL_MS = 1000 * 60 * 10;

function cacheKeyZip(zip) {
  return crypto.createHash("md5").update(String(zip).trim()).digest("hex");
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

// Endpoints
app.get("/", (_, res) => res.status(200).send("ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * 1) Geocode ZIP to a point using ArcGIS World Geocoding
 * (matches what GSIS UI uses: "ArcGIS World Geocoding Service")
 *
 * NOTE: This is public ArcGIS geocode service.
 */
async function geocodeZipToPoint(zip) {
  const q = String(zip).trim();

  // ArcGIS World Geocoding (public)
  const geocodeUrl = "https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates";

  const params = new URLSearchParams({
    f: "json",
    singleLine: q,
    outFields: "*",
    maxLocations: "1",
    outSR: "4326"
  });

  const resp = await fetch(`${geocodeUrl}?${params.toString()}`, {
    headers: { "Accept": "application/json" }
  });

  if (!resp.ok) return null;
  const json = await resp.json().catch(() => null);
  const cand = json?.candidates?.[0];
  const loc = cand?.location;
  if (!loc || typeof loc.x !== "number" || typeof loc.y !== "number") return null;

  return { lng: loc.x, lat: loc.y, score: cand.score ?? null, address: cand.address ?? null };
}

/**
 * 2) Query GSIS zone layer by point (WGS84)
 */
async function queryZoneByPoint(lat, lng) {
  const url = "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/1/query";

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
    outFields: "ZONEREGISTRYID,ZONENAME,TIMH,CURRENTZONEVALUE",
    outSR: "4326",
    // small tolerance helps for boundary cases
    distance: "5",
    units: "esriSRUnit_Meter"
  });

  const resp = await fetch(`${url}?${params.toString()}`, {
    headers: { "Accept": "application/json" }
  });

  if (!resp.ok) return null;
  const json = await resp.json().catch(() => null);
  const attrs = json?.features?.[0]?.attributes;
  if (!attrs) return null;

  const tz = (attrs.TIMH ?? attrs.CURRENTZONEVALUE) ?? null;

  return {
    tz_eur_sqm: tz != null ? Number(tz) : null,
    zone_id: attrs.ZONEREGISTRYID != null ? String(attrs.ZONEREGISTRYID) : null,
    zone_name: attrs.ZONENAME != null ? String(attrs.ZONENAME) : null,
    raw: attrs
  };
}

// Main lookup (ZIP)
app.post("/lookup-zip", requireApiKey, async (req, res) => {
  try {
    const zip = String(req.body?.zip || "").trim();
    if (!zip) return res.status(400).json({ ok: false, error: "zip required" });

    const key = cacheKeyZip(zip);
    const cached = getCache(key);
    if (cached) return res.json({ ...cached, cached: true });

    const geo = await geocodeZipToPoint(zip);
    if (!geo) {
      const out = { ok: false, error: "Could not geocode zip", zip };
      cache.set(key, { ts: Date.now(), ttl: CACHE_FAIL_MS, data: out });
      return res.json({ ...out, cached: false });
    }

    const zone = await queryZoneByPoint(geo.lat, geo.lng);
    if (!zone || !zone.zone_id || !zone.tz_eur_sqm) {
      const out = {
        ok: false,
        error: "No attributes returned",
        zip,
        geocode: geo
      };
      cache.set(key, { ts: Date.now(), ttl: CACHE_FAIL_MS, data: out });
      return res.json({ ...out, cached: false });
    }

    const out = {
      ok: true,
      zip,
      tz_eur_sqm: zone.tz_eur_sqm,
      zone_id: zone.zone_id,
      zone_name: zone.zone_name,
      geocode: geo
    };

    cache.set(key, { ts: Date.now(), ttl: CACHE_OK_MS, data: out });
    return res.json({ ...out, cached: false });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ GHF GSIS Lookup ZIP service running on port ${PORT}`);
});