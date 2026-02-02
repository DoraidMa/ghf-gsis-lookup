import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;

// ---- CORS (for browser calls if you ever need it) ----
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (allowedOrigins.length === 0 || allowedOrigins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- API KEY ----
const API_KEY = process.env.API_KEY || "";
function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: "Unauthorized" });
  next();
}

// ---- Cache ----
const cache = new Map();
const CACHE_TTL_DAYS = Number(process.env.CACHE_TTL_DAYS || 30);
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * CACHE_TTL_DAYS;

function cacheKey(lat, lng) {
  const a = lat.toFixed(5);
  const b = lng.toFixed(5);
  return crypto.createHash("md5").update(`${a},${b}`).digest("hex");
}

// ---- Minimal Cookie Jar for GSIS ----
let gsisCookie = ""; // e.g. "AGS_ROLES=....; other=..."
let gsisCookieTs = 0;
const COOKIE_REFRESH_MS = 1000 * 60 * 30; // refresh every 30 min

function extractSetCookieHeaders(resp) {
  // Node fetch exposes set-cookie in different ways across runtimes
  const setCookie = resp.headers.get("set-cookie");
  return setCookie ? [setCookie] : [];
}

function mergeCookies(existing, setCookieHeaders) {
  const jar = new Map();
  // load existing
  (existing || "").split(";").map(x => x.trim()).filter(Boolean).forEach(kv => {
    const [k, ...rest] = kv.split("=");
    if (!k || rest.length === 0) return;
    jar.set(k, rest.join("="));
  });

  // apply new cookies
  for (const h of setCookieHeaders || []) {
    const first = String(h).split(";")[0]; // "NAME=VALUE"
    const [k, ...rest] = first.split("=");
    if (!k || rest.length === 0) continue;
    jar.set(k.trim(), rest.join("=").trim());
  }

  // rebuild cookie header
  return Array.from(jar.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function refreshGsisCookie() {
  // Hit proxy.php once — it usually sets AGS_ROLES
  const url = "https://maps.gsis.gr/valuemaps2/PHP/proxy.php?https://maps.gsis.gr/arcgis/rest/info?f=json";

  const resp = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; GHF-GSIS-Lookup/1.0)",
      "Accept": "application/json,text/plain,*/*",
    }
  });

  const setCookies = extractSetCookieHeaders(resp);
  gsisCookie = mergeCookies(gsisCookie, setCookies);
  gsisCookieTs = Date.now();
  return gsisCookie;
}

async function gsisProxyFetch(targetUrl) {
  // Ensure cookie exists / fresh
  if (!gsisCookie || (Date.now() - gsisCookieTs > COOKIE_REFRESH_MS)) {
    await refreshGsisCookie();
  }

  const proxyUrl = `https://maps.gsis.gr/valuemaps2/PHP/proxy.php?${encodeURIComponent(targetUrl)}`;

  const doFetch = async () => {
    return fetch(proxyUrl, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; GHF-GSIS-Lookup/1.0)",
        "Accept": "application/json,text/plain,*/*",
        "Cookie": gsisCookie
      }
    });
  };

  // 1st attempt
  let resp = await doFetch();

  // If 403, refresh cookie and retry once
  if (resp.status === 403) {
    await refreshGsisCookie();
    resp = await doFetch();
  }

  return resp;
}

app.get("/health", (_, res) => res.json({ ok: true }));

/**
 * POST /lookup
 * body: { lat, lng }
 */
app.post("/lookup", requireApiKey, async (req, res) => {
  try {
    const { lat, lng } = req.body || {};
    const latNum = Number(lat);
    const lngNum = Number(lng);

    if (!Number.isFinite(latNum) || !Number.isFinite(lngNum)) {
      return res.status(400).json({ ok: false, error: "lat/lng required" });
    }

    const key = cacheKey(latNum, lngNum);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return res.json({ ...cached.data, cached: true });
    }

    // ✅ This is the SAME dataset you were querying
    // IMPORTANT: geometry needs to be point WGS84 with inSR=4326
    const base =
      "https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/1/query";

    const params = new URLSearchParams({
      f: "json",
      where: "1=1",
      returnGeometry: "false",
      geometryType: "esriGeometryPoint",
      spatialRel: "esriSpatialRelIntersects",
      inSR: "4326",
      outSR: "4326",
      outFields: "ZONEREGISTRYID,ZONENAME,TIMH,CURRENTZONEVALUE",
      geometry: JSON.stringify({
        x: lngNum,
        y: latNum,
        spatialReference: { wkid: 4326 }
      })
    });

    const targetUrl = `${base}?${params.toString()}`;

    const resp = await gsisProxyFetch(targetUrl);
    const text = await resp.text();

    // If not JSON, return debug snippet
    let json;
    try { json = JSON.parse(text); } catch {
      const out = { ok: false, error: `GSIS non-JSON response (HTTP ${resp.status})`, detail: text.slice(0, 500) };
      cache.set(key, { ts: Date.now(), data: out });
      return res.status(200).json(out);
    }

    const attrs = json?.features?.[0]?.attributes;
    if (!attrs) {
      const out = { ok: false, error: `No attributes returned (HTTP ${resp.status})`, detail: json?.error || null };
      cache.set(key, { ts: Date.now(), data: out });
      return res.status(200).json(out);
    }

    const tz = (attrs.TIMH ?? attrs.CURRENTZONEVALUE) ?? null;

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

app.listen(PORT, () => console.log(`GHF GSIS Lookup service running on port ${PORT}`));