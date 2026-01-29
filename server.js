import express from "express";
import crypto from "crypto";
import { chromium } from "playwright";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;

// --- CORS ---
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- API key ---
const API_KEY = process.env.API_KEY || "";
function requireApiKey(req, res, next) {
  if (!API_KEY) return next(); // if not set, allow (not recommended)
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

// WGS84 -> WebMercator (EPSG:102100)
function toWebMercator(lat, lng) {
  const x = (lng * 20037508.34) / 180.0;
  let y = Math.log(Math.tan(((90.0 + lat) * Math.PI) / 360.0)) / (Math.PI / 180.0);
  y = (y * 20037508.34) / 180.0;
  return { x, y };
}

async function gsisLookupViaBrowser(lat, lng) {
  const { x, y } = toWebMercator(lat, lng);

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const page = await browser.newPage();

  // establish cookies/session
  await page.goto("https://maps.gsis.gr/valuemaps/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  const result = await page.evaluate(async ({ x, y }) => {
    const base =
      "https://maps.gsis.gr/valuemaps2/PHP/proxy.php?https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/1/query";

    const params = new URLSearchParams({
      f: "json",
      where: "",
      returnGeometry: "true",
      spatialRel: "esriSpatialRelIntersects",
      geometry: JSON.stringify({ x, y, spatialReference: { wkid: 102100 } }),
      geometryType: "esriGeometryPoint",
      inSR: "102100",
      outFields: "ZONENAME,CURRENTZONEVALUE,ZONEREGISTRYID,TIMH",
      outSR: "102100",
      distance: "0.01",
      units: "esriSRUnit_Meter",
    });

    const url = `${base}?${params.toString()}`;
    const res = await fetch(url, { method: "GET", credentials: "include" });
    const json = await res.json();

    const attrs = json?.features?.[0]?.attributes;
    if (!attrs) return { ok: false, error: "No attributes returned" };

    const tz = (attrs.TIMH ?? attrs.CURRENTZONEVALUE) ?? null;

    return {
      ok: true,
      zone_id: attrs.ZONEREGISTRYID ?? null,
      zone_name: attrs.ZONENAME ?? null,
      tz_eur_sqm: tz != null ? Number(tz) : null,
    };
  }, { x, y });

  await browser.close();
  return result;
}

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
    const cached = cache.get(key);

    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return res.json({ ...cached.data, cached: true });
    }

    const data = await gsisLookupViaBrowser(latNum, lngNum);

    cache.set(key, { ts: Date.now(), data });

    return res.json({ ...data, cached: false });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log(`GHF GSIS Lookup service running on port ${PORT}`));
