// POST /api/run  { pairId: "F1", config: "defect" | "compliant" }
// Runs one matched pair live: two agent replies, then one blind fact extraction.
// The browser never sends prompts or sees the API key. Prompts are built here from core.js,
// so this endpoint cannot be used as a general-purpose proxy to the model.
const C = require("../core.js");

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = process.env.ANTHROPIC_MODEL || "claude-haiku-5-5";
const PER_IP_PER_HOUR = Number(process.env.RUNS_PER_IP_PER_HOUR || 40); // 12 pairs per full run

// Best-effort limiter. Serverless instances do not share memory, so the real cost ceiling
// is the monthly spend limit you set in the Anthropic Console.
const hits = new Map();
function limited(ip) {
  const now = Date.now(), hour = 3600e3;
  const list = (hits.get(ip) || []).filter(t => now - t < hour);
  if (list.length >= PER_IP_PER_HOUR) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  return false;
}

async function callModel(prompt, maxTokens) {
  const r = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error((data.error && data.error.message) || `Model API error ${r.status}`);
    err.status = r.status;
    throw err;
  }
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  if (!text) { const e = new Error("The model returned an empty reply."); e.status = 502; throw e; }
  return text;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (e) {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch (e) {} }
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e) {} }
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return res.status(405).json({ error: "Use POST." }); }
  if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: "Live runs are not configured on this deployment." });

  const body = typeof req.body === "string" ? (() => { try { return JSON.parse(req.body); } catch (e) { return {}; } })() : (req.body || {});
  const pair = C.PAIRS.find(p => p.id === body.pairId);
  const config = C.CONFIGS[body.config] ? body.config : null;
  if (!pair || !config) return res.status(400).json({ error: "Unknown pair or configuration." });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (limited(ip)) return res.status(429).json({ error: "Run limit reached for now. Try again in an hour." });

  try {
    const [ctrl, test] = await Promise.all([
      callModel(C.agentPrompt(config, pair.control), 400),
      callModel(C.agentPrompt(config, pair.test), 400)
    ]);
    const swapped = Math.random() < 0.5; // blind the extractor to which reply is which
    const raw = await callModel(C.extractionPrompt(swapped ? test : ctrl, swapped ? ctrl : test), 600);
    const ex = parseJson(raw);
    if (!ex) return res.status(502).json({ error: "The fact extractor returned unreadable output." });
    const fa = C.normFacts(ex.a), fb = C.normFacts(ex.b);
    return res.status(200).json({
      pairId: pair.id, config, model: MODEL, swapped,
      control: { text: ctrl, facts: swapped ? fb : fa },
      test: { text: test, facts: swapped ? fa : fb }
    });
  } catch (e) {
    const status = e.status === 429 ? 429 : e.status === 401 ? 503 : 502;
    const msg = e.status === 401 ? "The server's API key was rejected." : e.status === 429 ? "The model is rate limited. Try again shortly." : "The model call failed.";
    return res.status(status).json({ error: msg });
  }
};
