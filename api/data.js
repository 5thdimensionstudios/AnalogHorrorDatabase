/**
 * Analog Horror Database — Vercel API Route
 * /api/data
 *
 * Reads and writes ALL keys from the Supabase `store` table dynamically.
 * This correctly handles per-series rating/review keys like ahw_r_s101,
 * ahw_rv_s101, etc., in addition to the core data keys.
 *
 * Required Vercel environment variables:
 *   SUPABASE_URL  — e.g. https://yourproject.supabase.co
 *   SUPABASE_KEY  — your SERVICE ROLE key (not anon key)
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const HEADERS = {
  "apikey":        SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type":  "application/json",
};

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ── Core data keys that are always expected ────────────────────────────────────
const CORE_KEYS = ["ahw_series", "ahw_chars", "ahw_eps", "ahw_settings"];

// ── Supabase helpers ───────────────────────────────────────────────────────────

/** Fetch a single value by key. Returns null if not found. */
async function dbGet(key) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/store?key=eq.${encodeURIComponent(key)}&select=value`,
    { headers: HEADERS }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase GET failed for "${key}": ${res.status} — ${err}`);
  }
  const rows = await res.json();
  return rows.length > 0 ? rows[0].value : null;
}

/** Fetch ALL rows from the store table. Returns { key: value, ... } */
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
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

/** Upsert a single key/value pair. */
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

/** Delete a key (used for cleanup if needed). */
async function dbDelete(key) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/store?key=eq.${encodeURIComponent(key)}`,
    { method: "DELETE", headers: HEADERS }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Supabase DELETE failed for "${key}": ${res.status} — ${err}`);
  }
}

// ── Database read/write ────────────────────────────────────────────────────────

/** Read all data from Supabase. Fills in empty defaults for core keys. */
async function readDb() {
  const data = await dbGetAll();

  // Ensure core keys always exist with sensible defaults
  if (!("ahw_series"   in data)) data.ahw_series   = [];
  if (!("ahw_chars"    in data)) data.ahw_chars     = [];
  if (!("ahw_eps"      in data)) data.ahw_eps       = [];
  if (!("ahw_settings" in data)) data.ahw_settings  = {};

  return data;
}

/**
 * Write all data to Supabase.
 * Upserts every key in the incoming object.
 */
async function writeDb(data) {
  await Promise.all(
    Object.entries(data).map(([key, value]) => dbSet(key, value))
  );
}

// ── Merge logic ────────────────────────────────────────────────────────────────

/**
 * Merges incoming data over current data.
 * For arrays of objects with IDs, preserves images that may have been stripped
 * for bandwidth in non-admin reads.
 */
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
      // Merge arrays by ID, restoring images that were stripped on GET
      const curById = {};
      for (const item of curVal) curById[item.id] = item;

      merged[key] = inVal.map(inItem => {
        const curItem = curById[inItem.id];
        if (!curItem) return inItem;

        const restoredImages =
          (!inItem.images || inItem.images.length === 0) &&
          curItem.images && curItem.images.length > 0
            ? curItem.images
            : inItem.images;

        const restoredImage =
          inItem.image === null && curItem.image
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

/**
 * Strips heavy image data from the response for non-admin reads.
 * Cover images are kept; all other base64 image data is removed.
 */
function stripImages(data) {
  if (!data) return data;
  const out = { ...data };

  if (out.ahw_series) {
    out.ahw_series = out.ahw_series.map(s => ({
      ...s,
      images: (s.images || []).map(img => ({
        ...img,
        data: img.iscover ? img.data : undefined,
      })),
    }));
  }

  if (out.ahw_chars) {
    out.ahw_chars = out.ahw_chars.map(c => ({
      ...c,
      image:  null,
      images: [],
    }));
  }

  if (out.ahw_eps) {
    out.ahw_eps = out.ahw_eps.map(e => ({
      ...e,
      images: [],
    }));
  }

  return out;
}

// ── Vercel handler ─────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // CORS headers on every response
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type",  "application/json");

  // ── Debug endpoint: /api/data?debug=1 ──────────────────────────────────────
  if (req.query?.debug === "1") {
    return res.status(200).json({
      SUPABASE_URL: SUPABASE_URL || "NOT SET",
      SUPABASE_KEY: SUPABASE_KEY
        ? `set (${SUPABASE_KEY.length} chars)`
        : "NOT SET",
    });
  }

  // ── GET — return the full database ─────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const data    = await readDb();
      const isAdmin = req.query?.admin === "1";
      return res.status(200).json(isAdmin ? data : stripImages(data));
    } catch (err) {
      console.error("READ ERROR:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST — merge and save incoming data ────────────────────────────────────
  if (req.method === "POST") {
    let incoming;
    try {
      incoming = typeof req.body === "string"
        ? JSON.parse(req.body)
        : req.body;
    } catch {
      return res.status(400).json({ error: "Invalid JSON" });
    }

    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return res.status(400).json({ error: "Body must be a JSON object" });
    }

    try {
      const current = await readDb();
      const merged  = smartMerge(current, incoming);
      await writeDb(merged);
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("WRITE ERROR:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
};
