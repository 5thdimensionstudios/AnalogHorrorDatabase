/**
 * Migration script — moves existing base64 images out of the database
 * and into Supabase Storage, replacing them with public URLs.
 *
 * Usage:
 *   node migrate.js
 *
 * Set these before running (or put them in a .env file):
 *   SUPABASE_URL=https://yourproject.supabase.co
 *   SUPABASE_KEY=your-service-role-key
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const BUCKET = "images";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌  Set SUPABASE_URL and SUPABASE_KEY environment variables first.");
  process.exit(1);
}

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

// ── Supabase helpers ──────────────────────────────────────────────────────────

async function dbGetAll() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/store?select=key,value`, { headers: HEADERS });
  if (!res.ok) throw new Error(`GET failed: ${await res.text()}`);
  const rows = await res.json();
  const result = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

async function dbSet(key, value) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/store`, {
    method: "POST",
    headers: { ...HEADERS, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ key, value }),
  });
  if (!res.ok) throw new Error(`SET "${key}" failed: ${await res.text()}`);
}

async function uploadToStorage(base64Data, mimeType, filename) {
  // Strip prefix if present: "data:image/png;base64,..."
  const raw = base64Data.includes(",") ? base64Data.split(",")[1] : base64Data;
  const buffer = Buffer.from(raw, "base64");

  const ext = mimeType ? mimeType.split("/")[1] || "jpg" : "jpg";
  const path = `migrated-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": mimeType || "image/jpeg",
      "x-upsert": "true",
    },
    body: buffer,
  });

  if (!res.ok) throw new Error(`Storage upload failed: ${await res.text()}`);
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
}

// ── Migration helpers ─────────────────────────────────────────────────────────

function isBase64(str) {
  return typeof str === "string" && str.startsWith("data:image/");
}

function getMime(dataUrl) {
  const match = dataUrl.match(/^data:(image\/[^;]+);base64,/);
  return match ? match[1] : "image/jpeg";
}

async function migrateImageArray(items, label) {
  let count = 0;
  for (const item of items) {
    // Multi-image array (series, episodes)
    if (Array.isArray(item.images)) {
      for (const img of item.images) {
        if (isBase64(img.data)) {
          process.stdout.write(`  Uploading ${label} "${item.title || item.name || item.id}" image "${img.name || img.id}"... `);
          const url = await uploadToStorage(img.data, getMime(img.data), img.name || img.id);
          img.data = url;
          console.log("✓");
          count++;
        }
      }
    }
    // Single portrait image (characters)
    if (isBase64(item.image)) {
      process.stdout.write(`  Uploading ${label} "${item.name || item.id}" portrait... `);
      const url = await uploadToStorage(item.image, getMime(item.image), item.id + "-portrait");
      item.image = url;
      console.log("✓");
      count++;
    }
  }
  return count;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("📦 Reading database from Supabase...");
  const db = await dbGetAll();

  let total = 0;

  if (Array.isArray(db.ahw_series)) {
    console.log(`\n🎬 Series (${db.ahw_series.length} entries)`);
    total += await migrateImageArray(db.ahw_series, "series");
  }

  if (Array.isArray(db.ahw_chars)) {
    console.log(`\n👤 Characters (${db.ahw_chars.length} entries)`);
    total += await migrateImageArray(db.ahw_chars, "character");
  }

  if (Array.isArray(db.ahw_eps)) {
    console.log(`\n📼 Episodes (${db.ahw_eps.length} entries)`);
    total += await migrateImageArray(db.ahw_eps, "episode");
  }

  if (total === 0) {
    console.log("\n✅ No base64 images found — database is already clean!");
    return;
  }

  console.log(`\n💾 Saving cleaned database back (${total} images migrated)...`);
  await Promise.all([
    dbSet("ahw_series",   db.ahw_series   || []),
    dbSet("ahw_chars",    db.ahw_chars    || []),
    dbSet("ahw_eps",      db.ahw_eps      || []),
    dbSet("ahw_settings", db.ahw_settings || {}),
  ]);

  console.log(`\n✅ Done! ${total} images moved to Supabase Storage.`);
  console.log("   Your database should now be much smaller.");
}

main().catch(err => {
  console.error("\n❌ Migration failed:", err.message);
  process.exit(1);
});
