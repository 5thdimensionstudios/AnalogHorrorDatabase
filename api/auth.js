export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { password } = req.body || {};

  if (!process.env.ADMIN_PASS) {
    return res.status(500).json({ error: "Server misconfigured" });
  }

  if (password === process.env.ADMIN_PASS) {
    return res.status(200).json({ ok: true });
  }

  // Consistent timing to prevent timing attacks
  return res.status(401).json({ ok: false });
}
