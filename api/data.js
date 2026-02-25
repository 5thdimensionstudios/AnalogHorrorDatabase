/**
 * Analog Horror Database — Vercel API Route
 * /api/data
 *
 * Required Vercel environment variables:
 *   SUPABASE_URL  — e.g. https://yourproject.supabase.co
 *   SUPABASE_KEY  — your SERVICE ROLE key (not anon key)
 *   ADMIN_PASS    — your admin password (same as auth.js uses)
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ADMIN_PASS   = process.env.ADMIN_PASS;

const HEADERS = {
  "apikey":        SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type":  "application/json",
};

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
};

// Keys that require admin auth to write
const PROTECTED_KEYS = ["ahw_series", "ahw_chars", "ahw_eps", "ahw_settings"];

// ── Supabase helpers ───────────────────────────────────────────────────────────

async function dbGetAll() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/store?select=key,value`,
    { headers: HEADERS }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase GET ALL failed: ${res.status} — ${err}`);
  }
  const rows = await res.json();
  const result = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

async function dbSet(key, value) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/store`, {
    method:  "POST",
    headers: { ...HEADERS, "Prefer": "resolution=merge-duplicates" },
    body:    JSON.stringify({ key, value }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase SET failed for "${key}": ${res.status} — ${err}`);
  }
}

// ── Database read/write ────────────────────────────────────────────────────────

async function readDb() {
  const data = await dbGetAll();
  if (!("ahw_series"   in data)) data.ahw_series   = [];
  if (!("ahw_chars"    in data)) data.ahw_chars     = [];
  if (!("ahw_eps"      in data)) data.ahw_eps       = [];
  if (!("ahw_settings" in data)) data.ahw_settings  = {};
  return data;
}

async function writeDb(data) {
  await Promise.all(
    Object.entries(data).map(([key, value]) => dbSet(key, value))
  );
}

// ── Merge logic ────────────────────────────────────────────────────────────────

/**
 * Returns true if an images array appears to have been stripped
 * (entries exist but some/all are missing their base64 data).
 */
function hasStrippedImages(images) {
  if (!images || images.length === 0) return false;
  return images.some(img => !img.data);
}

function smartMerge(current, incoming) {
  const merged = { ...current };

  for (const key of Object.keys(incoming)) {
    const inVal  = incoming[key];
    const curVal = current[key];

    const isIdArray =
      Array.isArray(inVal) &&
      Array.isArray(curVal) &&
      inVal.length > 0 &&
      inVal[0] &&
      typeof inVal[0] === "object" &&
      inVal[0].id;

    if (isIdArray) {
      const curById = {};
      for (const item of curVal) curById[item.id] = item;

      merged[key] = inVal.map(inItem => {
        const curItem = curById[inItem.id];
        if (!curItem) return inItem;

        // Restore images if incoming has none OR has stripped entries (data: undefined)
        const restoredImages =
          curItem.images && curItem.images.length > 0 &&
          (!inItem.images || inItem.images.length === 0 || hasStrippedImages(inItem.images))
            ? curItem.images
            : inItem.images;

        // Restore single image field if it was nulled out during strip
        const restoredImage =
          (inItem.image === null || inItem.image === undefined) && curItem.image
            ? curItem.image
            : inItem.image;

        return { ...inItem, images: restoredImages, image: restoredImage };
      });
    } else {
      merged[key] = inVal;
    }
  }

  return merged;
}

// ── Image stripping for public (non-admin) reads ───────────────────────────────

function stripImages(data) {
  if (!data) return data;
  const out = { ...data };

  // For series: keep cover image data (base64 legacy) or url, strip non-cover base64
  if (out.ahw_series) {
    out.ahw_series = out.ahw_series.map(s => ({
      ...s,
      images: (s.images || []).map(img => ({
        ...img,
        // Keep url-based images fully; for legacy base64, only keep cover data
        data: img.url ? undefined : (img.iscover ? img.data : undefined),
      })),
    }));
  }

  // For chars/eps: strip any legacy base64 blobs; url-based images are kept as-is
  if (out.ahw_chars) {
    out.ahw_chars = out.ahw_chars.map(c => ({
      ...c,
      // Keep URL portraits (strings starting with http); strip legacy base64 portraits
      image:  c.image && c.image.startsWith("http") ? c.image : null,
      images: (c.images || []).map(img => ({ ...img, data: undefined })),
    }));
  }

  if (out.ahw_eps) {
    out.ahw_eps = out.ahw_eps.map(e => ({
      ...e,
      images: (e.images || []).map(img => ({ ...img, data: undefined })),
    }));
  }

  return out;
}

// ── Vercel handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type",  "application/json");

  // ── Debug endpoint ──────────────────────────────────────────────────────────
  if (req.query?.debug === "1") {
    return res.status(200).json({
      SUPABASE_URL: SUPABASE_URL || "NOT SET",
      SUPABASE_KEY: SUPABASE_KEY ? `set (${SUPABASE_KEY.length} chars)` : "NOT SET",
      ADMIN_PASS:   ADMIN_PASS   ? `set (${ADMIN_PASS.length} chars)`   : "NOT SET",
    });
  }

  // ── GET ─────────────────────────────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const adminToken = req.headers["x-admin-token"];
      const isAdmin    = adminToken && adminToken === ADMIN_PASS;
      const data       = await readDb();
      return res.status(200).json(data);
    } catch (err) {
      console.error("READ ERROR:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST ────────────────────────────────────────────────────────────────────
  if (req.method === "POST") {
    let incoming;
    try {
      incoming = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return res.status(400).json({ error: "Body must be a JSON object" });
    }

    // Check if this write touches protected (admin-only) keys
    const touchesProtected = Object.keys(incoming).some(k => PROTECTED_KEYS.includes(k));
    if (touchesProtected) {
      const adminToken = req.headers["x-admin-token"];
      if (!adminToken || adminToken !== ADMIN_PASS) {
        return res.status(403).json({ error: "Unauthorized — admin token required for this operation" });
      }
    }

    try {
      const current = await readDb();
      // purge=1 bypasses smartMerge so the cleanup tool can strip base64 blobs
      const purge = req.query && req.query.purge === '1';
      const merged = purge ? { ...current, ...incoming } : smartMerge(current, incoming);
      await writeDb(merged);
      return res.status(200).json({ success: true, purge: !!purge });
    } catch (err) {
      console.error("WRITE ERROR:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
};
