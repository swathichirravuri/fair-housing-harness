// GET /api/health  -> { live: true|false, model }
// Tells the page whether live runs are configured, without exposing the key.
module.exports = function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ live: Boolean(process.env.ANTHROPIC_API_KEY), model: process.env.ANTHROPIC_MODEL || "claude-haiku-5-5" });
};
