const OWNER = process.env.REPO_OWNER;
const REPO  = process.env.REPO_NAME;
const PATH  = process.env.DB_FILE_PATH;
const TOKEN = process.env.GITHUB_TOKEN;

const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;

const GH_HEADERS = {
  Authorization: `token ${TOKEN}`,
  "Content-Type": "application/json",
  "User-Agent": "vercel-function"
};

// In-memory cache — survives across requests on the same warm instance.
// Cuts GitHub API calls dramatically under real traffic.
let _cache = null;
let _cacheSha = null;
let _cacheTime = 0;
const CACHE_TTL = 10000; // 10 seconds — fresh enough, cuts redundant reads

async function readFile() {
  const now = Date.now();
  if (_cache && (now - _cacheTime) < CACHE_TTL) {
    return { data: _cache, sha: _cacheSha };
  }
  try {
    const res = await fetch(API, { headers: GH_HEADERS });
    if (res.status === 404) return { data: {}, sha: null };
    if (!res.ok) return { data: _cache || {}, sha: _cacheSha };
    const json = await res.json();
    const raw = Buffer.from(json.content, "base64").toString("utf-8");
    _cache = JSON.parse(raw);
    _cacheSha = json.sha;
    _cacheTime = now;
    return { data: _cache, sha: _cacheSha };
  } catch (err) {
    return { data: _cache || {}, sha: _cacheSha };
  }
}

async function writeFile(newData, sha) {
  const content = Buffer.from(JSON.stringify(newData, null, 2)).toString("base64");
  const body = { message: "Update database", content, ...(sha ? { sha } : {}) };
  const res = await fetch(API, {
    method: "PUT",
    headers: GH_HEADERS,
    body: JSON.stringify(body)
  });
  if (res.ok) {
    // Update cache immediately so next read is instant
    _cache = newData;
    _cacheTime = Date.now();
    const json = await res.json();
    _cacheSha = json.content?.sha || _cacheSha;
  }
  return res.ok;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

module.exports = async (req, res) => {
  // Set CORS
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method === "GET") {
    const { data } = await readFile();

    // Cache-Control: CDN caches for 10s, browser for 5s.
    // Visitors get fast cached responses. Admins see changes within 10s.
    // This is the single biggest bandwidth optimization — CDN serves most requests
    // without hitting the function at all.
    res.setHeader("Cache-Control", "public, max-age=5, s-maxage=10, stale-while-revalidate=30");
    res.setHeader("Content-Type", "application/json");

    // Strip base64 images from public reads to massively reduce payload size.
    // Images are only needed by admins for editing. Visitors just see the data.
    const stripped = stripImages(data);
    return res.status(200).json(stripped);
  }

  if (req.method === "POST") {
    // Only admins POST. No caching on writes.
    let incoming;
    try {
      // Vercel provides body as object if Content-Type is application/json
      incoming = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).send("Invalid JSON");
    }

    const { data: current, sha } = await readFile();
    const merged = { ...current, ...incoming };
    const ok = await writeFile(merged, sha);

    if (!ok) return res.status(500).send("Failed to write to GitHub");

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ success: true });
  }

  return res.status(405).send("Method not allowed");
};

// Remove base64 image data from the payload sent to regular visitors.
// Images are still stored in GitHub — admins load them when they open edit mode.
// This can cut payload size by 90%+ when series have cover images.
function stripImages(data) {
  if (!data) return data;
  const out = { ...data };

  if (out.ahw_series) {
    out.ahw_series = out.ahw_series.map(s => ({
      ...s,
      images: (s.images || []).map(img => ({
        ...img,
        data: img.iscover ? img.data : undefined // keep only cover, strip rest
      }))
    }));
  }

  if (out.ahw_chars) {
    out.ahw_chars = out.ahw_chars.map(c => ({
      ...c,
      images: [] // strip all character images for visitors
    }));
  }

  if (out.ahw_eps) {
    out.ahw_eps = out.ahw_eps.map(e => ({
      ...e,
      images: [] // strip episode images for visitors
    }));
  }

  return out;
}
