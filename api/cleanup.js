/**
 * /api/cleanup.js
 * Visit: https://your-app.vercel.app/api/cleanup?pass=YOUR_ADMIN_PASSWORD
 * Strips all base64 image blobs from the database in one server-side operation.
 * Safe to run multiple times. Delete this file when done.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ADMIN_PASS   = process.env.ADMIN_PASS;

const HEADERS = {
  "apikey":        SUPABASE_KEY,
  "Authorization": `Bearer ${SUPABASE_KEY}`,
  "Content-Type":  "application/json",
};

async function dbGetAll() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/store?select=key,value`, { headers: HEADERS });
  if (!res.ok) throw new Error(`DB read failed: ${res.status}`);
  const rows = await res.json();
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

async function dbSet(key, value) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/store`, {
    method:  "POST",
    headers: { ...HEADERS, "Prefer": "resolution=merge-duplicates" },
    body:    JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error(`DB write failed for "${key}": ${res.status}`);
}

function stripBase64(item) {
  const out = { ...item };
  if (Array.isArray(out.images)) {
    out.images = out.images.map(img => {
      const clean = { ...img };
      delete clean.data;
      return clean;
    });
  }
  if (out.image && typeof out.image === "string" && out.image.startsWith("data:")) {
    out.image = null;
  }
  return out;
}

function countBlobs(items) {
  let n = 0;
  for (const item of items) {
    if (item.image && typeof item.image === "string" && item.image.startsWith("data:")) n++;
    for (const img of (item.images || [])) {
      if (img.data && typeof img.data === "string" && img.data.startsWith("data:")) n++;
    }
  }
  return n;
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "text/plain");

  // Auth check
  const pass = req.query && req.query.pass;
  if (!pass || pass !== ADMIN_PASS) {
    return res.status(401).send("Unauthorized. Usage: /api/cleanup?pass=YOUR_ADMIN_PASSWORD");
  }

  const log = [];
  const out = (msg) => { log.push(msg); console.log(msg); };

  try {
    out("Reading database...");
    const data = await dbGetAll();

    const series = data.ahw_series || [];
    const chars  = data.ahw_chars  || [];
    const eps    = data.ahw_eps    || [];

    const sb = countBlobs(series);
    const cb = countBlobs(chars);
    const eb = countBlobs(eps);
    const total = sb + cb + eb;

    out(`Found: ${series.length} series, ${chars.length} characters, ${eps.length} episodes`);
    out(`Base64 blobs: ${sb} in series, ${cb} in characters, ${eb} in episodes`);
    out(`Total to remove: ${total}`);

    if (total === 0) {
      out("Nothing to clean up — already done!");
      return res.status(200).send(log.join("\n"));
    }

    out("Stripping blobs...");
    const cleanSeries = series.map(stripBase64);
    const cleanChars  = chars.map(stripBase64);
    const cleanEps    = eps.map(stripBase64);

    out("Saving series...");
    await dbSet("ahw_series", cleanSeries);
    out("Series saved.");

    out("Saving characters...");
    await dbSet("ahw_chars", cleanChars);
    out("Characters saved.");

    out("Saving episodes...");
    await dbSet("ahw_eps", cleanEps);
    out("Episodes saved.");

    out("");
    out("✅ DONE! Removed " + total + " base64 blob(s).");
    out("All titles, descriptions, ratings and URL images are untouched.");
    out("You can now delete api/cleanup.js from your repo.");

    return res.status(200).send(log.join("\n"));

  } catch (e) {
    out("ERROR: " + e.message);
    return res.status(500).send(log.join("\n"));
  }
};
