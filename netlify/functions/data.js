const OWNER = process.env.REPO_OWNER;
const REPO  = process.env.REPO_NAME;
const PATH  = process.env.DB_FILE_PATH || "data/database.json";
const TOKEN = process.env.GITHUB_TOKEN;

const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`;

const GH_HEADERS = {
  Authorization: `token ${TOKEN}`,
  "Content-Type": "application/json",
  "User-Agent": "netlify-function"
};

// Returns { data: {}, sha: "..." } from GitHub
async function readFile() {
  try {
    const res = await fetch(API, { headers: GH_HEADERS });
    if (res.status === 404) {
      // File doesn't exist yet — return empty DB (no sha)
      return { data: {}, sha: null };
    }
    if (!res.ok) {
      console.error("GitHub read error:", res.status, await res.text());
      return { data: {}, sha: null };
    }
    const json = await res.json();
    // GitHub returns base64-encoded content
    const raw = Buffer.from(json.content, "base64").toString("utf-8");
    return { data: JSON.parse(raw), sha: json.sha };
  } catch (err) {
    console.error("readFile error:", err);
    return { data: {}, sha: null };
  }
}

// Writes newData to GitHub, requires the current sha to avoid conflicts
async function writeFile(newData, sha) {
  const content = Buffer.from(JSON.stringify(newData, null, 2), "utf-8").toString("base64");

  const body = {
    message: "Update database via admin panel",
    content,
    // sha is required when updating an existing file; omit for new files
    ...(sha ? { sha } : {})
  };

  const res = await fetch(API, {
    method: "PUT",
    headers: GH_HEADERS,
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text();
    console.error("GitHub write error:", res.status, txt);
    return false;
  }
  return true;
}

// CORS headers so your browser can call the function
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS };
  }

  // ── GET: return the entire database ──────────────────────────────
  if (event.httpMethod === "GET") {
    const { data } = await readFile();
    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify(data)
    };
  }

  // ── POST: merge & save incoming data ─────────────────────────────
  if (event.httpMethod === "POST") {
    let incoming;
    try {
      incoming = JSON.parse(event.body || "{}");
    } catch {
      return { statusCode: 400, headers: CORS, body: "Invalid JSON" };
    }

    // Read current DB (we need the sha to write back)
    const { data: current, sha } = await readFile();

    // Merge: incoming keys overwrite existing ones
    const merged = { ...current, ...incoming };

    const ok = await writeFile(merged, sha);
    if (!ok) {
      return { statusCode: 500, headers: CORS, body: "Failed to write to GitHub" };
    }

    return {
      statusCode: 200,
      headers: { ...CORS, "Content-Type": "application/json" },
      body: JSON.stringify({ success: true })
    };
  }

  return { statusCode: 405, headers: CORS, body: "Method not allowed" };
};
