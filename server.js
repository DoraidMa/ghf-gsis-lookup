import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = Number(process.env.PORT || 3000);
const API_KEY = process.env.API_KEY || "";

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

// cache
const cache = new Map();
const OK_TTL = 1000 * 60 * 60 * 24 * 30;
const FAIL_TTL = 1000 * 60 * 10;

function keyLL(lat, lng) {
  return crypto.createHash("md5").update(`${lat.toFixed(6)},${lng.toFixed(6)}`).digest("hex");
}
function getCache(k) {
  const v = cache.get(k);
  if (!v) return null;
  if (Date.now() - v.ts > v.ttl) {
    cache.delete(k);
    return null;
  }
  return v.data;
}

app.get("/", (_, res) => res.status(200).send("ok"));
app.get("/health", (_, res) => res.json({ ok: true }));

async function fetchJson(url) {
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
      "Referer": "https://maps.gsis.gr/valuemaps/",
      "Origin": "https://maps.gsis.gr"
    }
  });

  const text = await resp.text().catch(() => "");
  if (!resp.ok) return { ok: false, http: resp.status, text: text.slice(0, 240) };

  try {
    return { ok: true, json: JSON.parse(text) };
  } catch {
    return { ok: false, http: resp.status, text: text.slice(0, 240) };
  }
}

async function gsisLookup(lat, lng) {
  const geometry = JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } });

  // Identify (closest to clicking polygon)
  const identifyBase =
    "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/identify";

  const identifyParams = new URLSearchParams({
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

  let r = await fetchJson(`${identifyBase}?${identifyParams.toString()}`);
  if (r.ok) {
    const attrs = r.json?.results?.[0]?.attributes;
    if (attrs) {
      const tz = attrs.TIMH ?? attrs.CURRENTZONEVALUE ?? null;
      return {
        ok: true,
        tz_eur_sqm: tz != null ? Number(tz) : null,
        zone_id: attrs.ZONEREGISTRYID != null ? String(attrs.ZONEREGISTRYID) : null,
        zone_name: attrs.ZONENAME != null ? String(attrs.ZONENAME) : null
      };
    }
  }

  // Query fallback
  const queryBase =
    "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/1/query";

  const queryParams = new URLSearchParams({
    f: "json",
    where: "1=1",
    returnGeometry: "false",
    geometryType: "esriGeometryPoint",
    spatialRel: "esriSpatialRelIntersects",
    inSR: "4326",
    outSR: "4326",
    outFields: "ZONEREGISTRYID,ZONENAME,TIMH,CURRENTZONEVALUE",
    distance: "25",
    units: "esriSRUnit_Meter",
    geometry
  });

  r = await fetchJson(`${queryBase}?${queryParams.toString()}`);
  if (!r.ok) return { ok: false, error: `GSIS HTTP ${r.http}`, detail: r.text };

  const attrs = r.json?.features?.[0]?.attributes;
  if (!attrs) return { ok: false, error: "No attributes returned" };

  const tz = attrs.TIMH ?? attrs.CURRENTZONEVALUE ?? null;
  return {
    ok: true,
    tz_eur_sqm: tz != null ? Number(tz) : null,
    zone_id: attrs.ZONEREGISTRYID != null ? String(attrs.ZONEREGISTRYID) : null,
    zone_name: attrs.ZONENAME != null ? String(attrs.ZONENAME) : null
  };
}

app.post("/lookup", requireApiKey, async (req, res) => {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ ok: false, error: "lat/lng required" });
    }

    const k = keyLL(lat, lng);
    const cached = getCache(k);
    if (cached) return res.json({ ...cached, cached: true });

    const data = await gsisLookup(lat, lng);
    cache.set(k, { ts: Date.now(), ttl: data.ok ? OK_TTL : FAIL_TTL, data });

    return res.json({ ...data, cached: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ ghf-gsis-lookup running on port ${PORT}`);
});