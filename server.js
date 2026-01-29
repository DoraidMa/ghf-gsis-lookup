import express from "express";
import crypto from "crypto";
import { chromium } from "playwright-core";

const app = express();
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 3000;

/* ================= CORS ================= */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
    res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  }
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ================= API KEY ================= */
const API_KEY = process.env.API_KEY || "";

function requireApiKey(req, res, next) {
  if (!API_KEY) return next();
  if (req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  next();
}

/* ================= CACHE ================= */
const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30;

function cacheKey(lat, lng) {
  return crypto
    .createHash("md5")
    .update(`${lat.toFixed(5)},${lng.toFixed(5)}`)
    .digest("hex");
}

/* ================= HELPERS ================= */
function toWebMercator(lat, lng) {
  const x = (lng * 20037508.34) / 180;
  let y = Math.log(Math.tan((90 + lat) * Math.PI / 360)) / (Math.PI / 180);
  y = (y * 20037508.34) / 180;
  return { x, y };
}

/* ================= GSIS LOOKUP ================= */
async function gsisLookup(lat, lng) {
  const { x, y } = toWebMercator(lat, lng);

  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  try {
    const page = await browser.newPage();

    await page.goto("https://maps.gsis.gr/valuemaps/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    return await page.evaluate(async ({ x, y }) => {
      const base =
        "https://maps.gsis.gr/valuemaps2/PHP/proxy.php?https://maps.gsis.gr/arcgis/rest/services/APAA_PUBLIC/PUBLIC_ZONES_APAA_2021_INFO/MapServer/1/query";

      const params = new URLSearchParams({
        f: "json",
        geometryType: "esriGeometryPoint",
        spatialRel: "esriSpatialRelIntersects",
        geometry: JSON.stringify({ x, y, spatialReference: { wkid: 102100 } }),
        inSR: "102100",
        outFields: "ZONEREGISTRYID,ZONENAME,TIMH,CURRENTZONEVALUE",
      });

      const res = await fetch(`${base}?${params}`);
      const json = await res.json();

      const a = json?.features?.[0]?.attributes;
      if (!a) return { ok: false, error: "No GSIS data" };

      return {
        ok: true,
        zone_id: a.ZONEREGISTRYID ?? null,
        zone_name: a.ZONENAME ?? null,
        tz_eur_sqm: Number(a.TIMH ?? a.CURRENTZONEVALUE ?? null),
      };
    }, { x, y });

  } finally {
    await browser.close();
  }
}

/* ================= ROUTES ================= */
app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/lookup", requireApiKey, async (req, res) => {
  try {
    const { lat, lng } = req.body || {};
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ ok: false, error: "lat/lng required" });
    }

    const key = cacheKey(lat, lng);
    const cached = cache.get(key);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
      return res.json({ ...cached.data, cached: true });
    }

    const data = await gsisLookup(lat, lng);
    cache.set(key, { ts: Date.now(), data });

    res.json({ ...data, cached: false });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.listen(PORT, () =>
  console.log(`✅ GHF GSIS Lookup running on port ${PORT}`)
);