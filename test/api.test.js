// Run with: node test/api.test.js
// Exercises api/run.js with a mocked model API, so no key or network is needed.
const assert = require("assert");

process.env.ANTHROPIC_API_KEY = "test-key";
const calls = [];
global.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  calls.push({ url, headers: opts.headers, body });
  const prompt = body.messages[0].content;
  let text;
  if (prompt.includes("You extract facts")) {
    text = 'Here you go: {"a":{"units":["2B-204","2B-318","2B-112"],"concession":true,"fees":[],"nextStep":"self_tour","discouraging":false,"qualifies":"n/a","quote":""},"b":{"units":["2B-112"],"concession":false,"fees":[],"nextStep":"agent_tour","discouraging":false,"qualifies":"n/a","quote":"families love 2B-112"}}';
  } else {
    text = "Mock agent reply.";
  }
  return { ok: true, status: 200, json: async () => ({ content: [{ type: "text", text }] }) };
};

const handler = require("../api/run.js");
function mockRes() {
  return { code: 0, body: null, headers: {},
    status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; } };
}

(async () => {
  // Rejects arbitrary input
  let res = mockRes();
  await handler({ method: "POST", body: { pairId: "XX", config: "defect" }, headers: {} }, res);
  assert.strictEqual(res.code, 400);

  res = mockRes();
  await handler({ method: "GET", headers: {} }, res);
  assert.strictEqual(res.code, 405);

  // Runs a real pair: 2 agent calls + 1 extraction, key only in server headers
  calls.length = 0;
  res = mockRes();
  await handler({ method: "POST", body: { pairId: "F2", config: "defect" }, headers: { "x-forwarded-for": "1.2.3.4" } }, res);
  assert.strictEqual(res.code, 200, JSON.stringify(res.body));
  assert.strictEqual(calls.length, 3);
  assert.ok(calls.every(c => c.headers["x-api-key"] === "test-key"));
  assert.ok(calls[0].body.messages[0].content.includes("Operating rules"));
  assert.ok(!JSON.stringify(res.body).includes("test-key"), "key never returned");
  const { control, test } = res.body;
  assert.ok(Array.isArray(control.facts.units) && Array.isArray(test.facts.units));
  // Whichever order the extractor saw, facts are mapped back to the right tester
  const sets = [control.facts.units.length, test.facts.units.length].sort();
  assert.deepStrictEqual(sets, [1, 3]);

  // Missing key -> 503, not a crash
  delete process.env.ANTHROPIC_API_KEY;
  res = mockRes();
  await handler({ method: "POST", body: { pairId: "F2", config: "defect" }, headers: {} }, res);
  assert.strictEqual(res.code, 503);

  console.log("All API tests passed.");
})().catch(e => { console.error(e); process.exit(1); });
