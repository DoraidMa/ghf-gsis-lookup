app.post("/lookup-zip", requireApiKey, async (req, res) => {
  try {
    let zip = String(req.body?.zip || "").replace(/\D+/g, "");
    if (zip.length !== 5) return res.status(400).json({ ok: false, error: "zip must be 5 digits" });

    const k = makeCacheKey({ type: "zip", zip });
    const hit = cacheGet(k);
    if (hit) return res.json({ ...hit, cached: true });

    // EXACT where clause style you captured
    const where = `ZONEREGISTRYID = ${zip} or UPPER(OIKISMOS) LIKE '%${zip}%'`;

    // IMPORTANT: match your captured request exactly (only ZONENAME,OBJECTID)
    const params = new URLSearchParams({
      f: "json",
      where,
      returnGeometry: "false",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "ZONENAME,OBJECTID",
      outSR: "102100",
      resultRecordCount: "6"
    });

    const targetUrl = `${ZIP_LAYER_URL}?${params.toString()}`;
    const r = await gsisProxyJson(targetUrl);

    if (!r.ok) {
      cacheSet(k, r);
      return res.json({ ...r, cached: false });
    }

    const attrs = r.json?.features?.[0]?.attributes;
    if (!attrs) {
      const out = { ok: false, error: "No attributes returned" };
      cacheSet(k, out);
      return res.json({ ...out, cached: false });
    }

    // This endpoint now returns what the ZIP search returns: zone name + object id
    const out = {
      ok: true,
      zip,
      zone_name: attrs.ZONENAME ?? null,
      object_id: attrs.OBJECTID ?? null
    };

    cacheSet(k, out);
    return res.json({ ...out, cached: false });

  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});