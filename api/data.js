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

let _cache = null;
let _cacheSha = null;
let _cacheTime = 0;
const CACHE_TTL = 10000;

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
    _cache = newData;
    _cacheTime = Date.now();
    const json = await res.json();
    _cacheSha = json.content?.sha || _cacheSha;
  }
  return res.ok;
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

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

module.exports = async (req, res) => {
  Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "GET") {
    const { data } = await readFile();
    // Always return fresh data — no CDN caching.
    // The in-memory _cache handles performance instead.
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/json");
    const full = req.query && req.query.admin === "1";
    return res.status(200).json(full ? data : stripImages(data));
  }

  if (req.method === "POST") {
    let incoming;
    try {
      incoming = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      return res.status(400).send("Invalid JSON");
    }
    const { data: current, sha } = await readFile();
    const merged = smartMerge(current, incoming);
    const ok = await writeFile(merged, sha);
    if (!ok) return res.status(500).send("Failed to write to GitHub");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ success: true });
  }

  return res.status(405).send("Method not allowed");
};
