 import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || "";

// cache
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

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * GSIS Identify through official proxy
 */
async function gsisIdentifyViaProxy(lat, lng) {
  const identifyBase =
    "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/identify";

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
    tolerance: "12",
    returnGeometry: "false",
    layers: "all:1",
    mapExtent: "-180,-90,180,90",
    imageDisplay: "800,600,96"
  });

  const identifyUrl = `${identifyBase}?${params.toString()}`;

  // proxy wrapper (same used by official app)
  const proxyUrl =
    "https://maps.gsis.gr/valuemaps2/PHP/proxy.php?" + encodeURIComponent(identifyUrl);

  const resp = await fetch(proxyUrl, {
    headers: { Accept: "application/json" }
  });

  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    return { ok: false, error: `GSIS HTTP ${resp.status}`, detail: txt.slice(0, 200) };
  }

  const json = await resp.json().catch(() => null);

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

    const data = await gsisIdentifyViaProxy(lat, lng);

    cache.set(key, { ts: Date.now(), ttl: data.ok ? CACHE_OK_MS : CACHE_FAIL_MS, data });

    return res.json({ ...data, cached: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ghf-gsis-lookup running on port ${PORT}`);
});