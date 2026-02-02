import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;

// ---------- ENV ----------
const API_KEY = process.env.API_KEY || "";
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const CACHE_TTL_DAYS = Number(process.env.CACHE_TTL_DAYS || 30);
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * CACHE_TTL_DAYS;

// ---------- CORS ----------
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

// ---------- API KEY ----------
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // allow if not set (not recommended)
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

// ---------- CACHE ----------
const cache = new Map();
function cacheKey(prefix, obj) {
  return crypto.createHash("md5").update(prefix + JSON.stringify(obj)).digest("hex");
}

// ---------- COOKIE JAR (AGS_ROLES) ----------
let gsisCookie = ""; // e.g. "AGS_ROLES=....; ..."
let gsisCookieTs = 0;
const COOKIE_TTL_MS = 1000 * 60 * 20; // refresh every ~20 minutes

function extractCookie(setCookieHeaders) {
  if (!setCookieHeaders) return "";
  const arr = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  // Grab only the AGS_ROLES cookie
  const found = arr.find((c) => String(c).startsWith("AGS_ROLES="));
  if (!found) return "";
  // Keep only "AGS_ROLES=..."; ignore attributes
  return String(found).split(";")[0];
}

async function ensureGsisCookie() {
  const fresh = gsisCookie && (Date.now() - gsisCookieTs) < COOKIE_TTL_MS;
  if (fresh) return gsisCookie;

  // This call sets AGS_ROLES cookie (same host as the proxy)
  const warmUrl = "https://maps.gsis.gr/valuemaps2/PHP/proxy.php?https://maps.gsis.gr/arcgis/rest/info?f=json";

  const r = await fetch(warmUrl, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      // a normal browser UA helps
      "User-Agent": "Mozilla/5.0 (compatible; GHF-GSIS-Lookup/1.0)"
    }
  });

  // Node fetch: headers.getSetCookie() exists in newer runtimes; otherwise read raw
  const setCookies = typeof r.headers.getSetCookie === "function" ? r.headers.getSetCookie() : r.headers.get("set-cookie");
  const cookie = extractCookie(setCookies);

  if (cookie) {
    gsisCookie = cookie;
    gsisCookieTs = Date.now();
  } else {
    // keep old cookie if we had one
  }

  return gsisCookie;
}

// ---------- HELPERS ----------
function buildProxyUrl(targetUrl) {
  // proxy.php expects the full target URL appended, not URL-encoded (browser does it that way)
  return `https://maps.gsis.gr/valuemaps2/PHP/proxy.php?${targetUrl}`;
}

async function proxyFetchJson(targetUrl) {
  const cookie = await ensureGsisCookie();

  const url = buildProxyUrl(targetUrl);
  const r = await fetch(url, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; GHF-GSIS-Lookup/1.0)",
      ...(cookie ? { "Cookie": cookie } : {})
    }
  });

  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}

  if (!r.ok) {
    return { ok: false, error: `GSIS HTTP ${r.status}`, detail: text.slice(0, 400) };
  }

  // If GSIS returns HTML error page, json will be null
  if (!json) {
    return { ok: false, error: "GSIS returned non-JSON", detail: text.slice(0, 400) };
  }

  return { ok: true, json };
}

// ---------- ENDPOINTS ----------
app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * POST /lookup  {lat,lng}
 * Gets TZ + ZoneID using point query via proxy.php (cookie-auth)
 */
app.post("/lookup", requireApiKey, async (req, res) => {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ ok: false, error: "lat/lng required" });
    }

    const key = cacheKey("ll:", { lat: +lat.toFixed(6), lng: +lng.toFixed(6) });
    const cached = cache.get(key);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
      return res.json({ ...cached.data, cached: true });
    }

    // Use the SAME dataset family you showed, but point query needs a layer that contains TIMH.
    // In many setups, 2021 layer "1" has TIMH, but if yours differs we can adjust.
    const target = new URL("https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/1/query");
    target.searchParams.set("f", "json");
    target.searchParams.set("where", "1=1");
    target.searchParams.set("returnGeometry", "false");
    target.searchParams.set("spatialRel", "esriSpatialRelIntersects");
    target.searchParams.set("geometryType", "esriGeometryPoint");
    target.searchParams.set("inSR", "4326");
    target.searchParams.set("outSR", "4326");
    target.searchParams.set("outFields", "ZONEREGISTRYID,ZONENAME,TIMH,CURRENTZONEVALUE");
    target.searchParams.set(
      "geometry",
      JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } })
    );

    const r = await proxyFetchJson(target.toString());
    if (!r.ok) {
      cache.set(key, { ts: Date.now(), data: r });
      return res.json({ ...r, cached: false });
    }

    const attrs = r.json?.features?.[0]?.attributes;
    if (!attrs) {
      const out = { ok: false, error: "No attributes returned" };
      cache.set(key, { ts: Date.now(), data: out });
      return res.json({ ...out, cached: false });
    }

    const tz = attrs.TIMH ?? attrs.CURRENTZONEVALUE ?? null;

    const out = {
      ok: true,
      tz_eur_sqm: tz != null ? Number(tz) : null,
      zone_id: attrs.ZONEREGISTRYID != null ? String(attrs.ZONEREGISTRYID) : null,
      zone_name: attrs.ZONENAME ?? null
    };

    cache.set(key, { ts: Date.now(), data: out });
    return res.json({ ...out, cached: false });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/**
 * POST /lookup-zip {zip}
 * Finds candidate zones by ZIP using the EXACT request style you captured (APAA_2018_INFO /MapServer/18/query).
 * Returns best match + zone_id.
 */
app.post("/lookup-zip", requireApiKey, async (req, res) => {
  try {
    let zip = String(req.body?.zip || "").trim();
    zip = zip.replace(/\D+/g, ""); // normalize "106 81" -> "10681"
    if (zip.length !== 5) return res.status(400).json({ ok: false, error: "zip must be 5 digits" });

    const key = cacheKey("zip:", { zip });
    const cached = cache.get(key);
    if (cached && (Date.now() - cached.ts) < CACHE_TTL_MS) {
      return res.json({ ...cached.data, cached: true });
    }

    // This matches your captured request, but we include ZONEREGISTRYID in outFields too.
    const target = new URL("https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2018_INFO/MapServer/18/query");
    target.searchParams.set("f", "json");
    target.searchParams.set(
      "where",
      `ZONEREGISTRYID = ${zip} OR UPPER(OIKISMOS) LIKE '%${zip}%'`
    );
    target.searchParams.set("returnGeometry", "false");
    target.searchParams.set("spatialRel", "esriSpatialRelIntersects");
    target.searchParams.set("outFields", "ZONEREGISTRYID,ZONENAME,OBJECTID");
    target.searchParams.set("outSR", "102100");
    target.searchParams.set("resultRecordCount", "6");

    const r = await proxyFetchJson(target.toString());
    if (!r.ok) {
      cache.set(key, { ts: Date.now(), data: r });
      return res.json({ ...r, cached: false });
    }

    const features = r.json?.features || [];
    const attrs = features?.[0]?.attributes || null;

    if (!attrs) {
      const out = { ok: false, error: "No candidates returned" };
      cache.set(key, { ts: Date.now(), data: out });
      return res.json({ ...out, cached: false });
    }

    const out = {
      ok: true,
      zip,
      zone_id: attrs.ZONEREGISTRYID != null ? String(attrs.ZONEREGISTRYID) : null,
      zone_name: attrs.ZONENAME ?? null,
      object_id: attrs.OBJECTID ?? null
    };

    cache.set(key, { ts: Date.now(), data: out });
    return res.json({ ...out, cached: false });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log(`GHF GSIS Lookup running on port ${PORT}`));