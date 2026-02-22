const OWNER = process.env.REPO_OWNER;
const REPO  = process.env.REPO_NAME;
const PATH  = process.env.DB_FILE_PATH;
const TOKEN = process.env.GITHUB_TOKEN;

const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;

const GH_HEADERS = {
  Authorization: `token ${TOKEN}`,
  "Content-Type": "application/json",
  "User-Agent": "vercel-function",
  "Accept": "application/vnd.github.v3+json"
};

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

async function readFile() {
  const res = await fetch(API, { headers: GH_HEADERS });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub GET failed: ${res.status} ${res.statusText} — ${body}`);
  }
  const json = await res.json();
  const raw = Buffer.from(json.content, "base64").toString("utf-8");
  return { data: JSON.parse(raw), sha: json.sha };
}

async function writeFile(newData, sha) {
  const content = Buffer.from(JSON.stringify(newData, null, 2)).toString("base64");
  const body = { message: "Update database", content, ...(sha ? { sha } : {}) };
  const res = await fetch(API, {
    method: "PUT",
    headers: GH_HEADERS,
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`GitHub PUT failed: ${res.status} ${res.statusText} — ${errBody}`);
  }
  const json = await res.json();
  return json.content?.sha;
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

  if (req.query && req.query.debug === "1") {
    return res.status(200).json({
      OWNER: OWNER || "NOT SET",
      REPO:  REPO  || "NOT SET",
      PATH:  PATH  || "NOT SET",
      TOKEN: TOKEN ? `set (${TOKEN.length} chars)` : "NOT SET",
      API_URL: API
    });
  }

  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "GET") {
    try {
      const { data } = await readFile();
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
      const { data: current, sha } = await readFile();
      const merged = smartMerge(current, incoming);
      await writeFile(merged, sha);
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error("WRITE ERROR:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
};
