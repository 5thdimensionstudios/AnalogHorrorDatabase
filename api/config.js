module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=3600");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") return res.status(204).end();

  return res.status(200).json({
    supabaseUrl:     process.env.SUPABASE_URL      || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  });
};
