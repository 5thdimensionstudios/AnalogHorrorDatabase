/**
 * Analog Horror Database — Image Upload API
 * /api/upload
 *
 * Receives a base64 image from the frontend, uploads it to
 * Supabase Storage, and returns the public URL.
 *
 * Required env vars (same as data.js):
 *   SUPABASE_URL
 *   SUPABASE_KEY  — service role key
 *   ADMIN_PASS
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ADMIN_PASS   = process.env.ADMIN_PASS;
const BUCKET       = "images"; // must match the bucket you created in Supabase Storage

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Admin-Token",
};

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  // Only admins can upload images
  const adminToken = req.headers["x-admin-token"];
  if (!adminToken || adminToken !== ADMIN_PASS) {
    return res.status(403).json({ error: "Unauthorized" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { data: base64Data, name, type } = body || {};

  if (!base64Data || !name || !type) {
    return res.status(400).json({ error: "Missing data, name, or type" });
  }

  // Strip the "data:image/...;base64," prefix if present
  const raw = base64Data.includes(",") ? base64Data.split(",")[1] : base64Data;

  // Convert base64 to binary buffer
  const buffer = Buffer.from(raw, "base64");

  // Build a unique filename
  const ext      = name.split(".").pop() || "jpg";
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const path     = filename;

  // Upload to Supabase Storage
  const uploadRes = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`,
    {
      method:  "POST",
      headers: {
        "apikey":         SUPABASE_KEY,
        "Authorization":  `Bearer ${SUPABASE_KEY}`,
        "Content-Type":   type,
        "x-upsert":       "true",
      },
      body: buffer,
    }
  );

  if (!uploadRes.ok) {
    const err = await uploadRes.text();
    console.error("Storage upload failed:", err);
    return res.status(500).json({ error: `Storage upload failed: ${err}` });
  }

  // Build the public URL
  const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;

  return res.status(200).json({ url: publicUrl });
};
