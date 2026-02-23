const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const HEADERS = {
  "apikey": SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json"
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

async function dbGet(key) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/store?key=eq.${key}&select=value`, {
    headers: HEADERS
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase GET failed: ${res.status} — ${err}`);
  }
  const rows = await res.json();
  return rows.length > 0 ? rows[0].value : null;
}

async function dbSet(key, value) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/store`, {
    method: "POST",
    headers: {
      ...HEADERS,
      "Prefer": "resolution=merge-duplicates"
    },
    body: JSON.stringify({ key, value })
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase SET failed: ${res.status} — ${err}`);
  }
}

async function readDb() {
  const [series, chars, eps, settings, ratings, reviews] = await Promise.all([
    dbGet("ahw_series"),
    dbGet("ahw_chars"),
    dbGet("ahw_eps"),
    dbGet("ahw_settings"),
    dbGet("ahw_ratings"),
    dbGet("ahw_reviews"),
  ]);
  return {
    ahw_series:   series   || [],
    ahw_chars:    chars    || [],
    ahw_eps:      eps      || [],
    ahw_settings: settings || {},
    ahw_ratings:  ratings  || {},
    ahw_reviews:  reviews  || {},
  };
}

async function writeDb(data) {
  const entries = Object.entries(data);
  await Promise.all(entries.map(([key, value]) => dbSet(key, value)));
}

function smartMerge(current, incoming) {
  const merged = { ...current };
  for (const key of Object.keys(incoming)) {
    const inVal = incoming[key];
    const curVal = current[key];
    if (
      Array.isArray(inVal) && Array.isArray(curVal) &&
      inVal.length > 0 && inVal[0] && typeof inVal[0] === "object" && inVal[0].id
    ) {
      const curById = {};
      for (const item of curVal) curById[item.id] = item;
      merged[key] = inVal.map(inItem => {
        const curItem = curById[inItem.id];
        if (!curItem) return inItem;
        const restoredImages =
          (!inItem.images || inItem.images.length === 0) && curItem.images && curItem.images.length > 0
            ? curItem.images : inItem.images;
        const restoredImage =
          inItem.image === null && curItem.image ? curItem.image : inItem.image;
        return { ...inItem, images: restoredImages, image: restoredImage };
      });
    } else {
      merged[key] = inVal;
    }
  }
  return merged;
}

function stripImages(data) {
  if (!data) return data;
  const out = { ...data };
  if (out.ahw_series) {
    out.ahw_series = out.ahw_series.map(s => ({
      ...s,
      images: (s.images || []).map(img => ({ ...img, data: img.iscover ? img.data : undefined }))
    }));
  }
  if (out.ahw_chars) {
    out.ahw_chars = out.ahw_chars.map(c => ({ ...c, image: null, images: [] }));
  }
  if (out.ahw_eps) {
    out.ahw_eps = out.ahw_eps.map(e => ({ ...e, images: [] }));
  }
  return out;
}

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  // Debug — visit /api/data?debug=1 to check config
  if (req.query && req.query.debug === "1") {
    return res.status(200).json({
      SUPABASE_URL: SUPABASE_URL || "NOT SET",
      SUPABASE_KEY: SUPABASE_KEY ? `set (${SUPABASE_KEY.length} chars)` : "NOT SET",
    });
  }

  if (req.method === "GET") {
    try {
      const data = await readDb();
      const full = req.query && req.query.admin === "1";
      return res.status(200).json(full ? data : stripImages(data));
    } catch (err) {
      console.error("READ ERROR:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === "POST") {
    let incoming;
    try {
      incoming = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }
    try {
      const current = await readDb();
      const merged = smartMerge(current, incoming);
      await writeDb(merged);
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("WRITE ERROR:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
};
