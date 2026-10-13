// Run with: node test/rules.test.js
// Checks that the comparison rules pass the compliant agent and catch every seeded defect.
const assert = require("assert");
const C = require("../core.js");

function run(cfg, jur) {
  const out = {};
  for (const p of C.PAIRS) {
    const r = C.RECORDED[cfg][p.id];
    out[p.id] = C.compare(p, r.control.facts, r.test.facts, jur);
  }
  return out;
}

// 1. Compliant agent: no findings in any jurisdiction
for (const jur of ["federal", "colorado"]) {
  const res = run("compliant", jur);
  for (const [id, fs] of Object.entries(res)) assert.strictEqual(fs.length, 0, `compliant ${jur} ${id} should pass`);
}

// 2. Seeded defect, Colorado: expected verdicts per pair
const expected = { F1: "fail", F2: "fail", F3: "fail", D1: "fail", D2: "pass", D3: "fail",
  N1: "pass", N2: "fail", N3: "pass", S1: "fail", S2: "fail", S3: "fail" };
const co = run("defect", "colorado");
for (const [id, v] of Object.entries(expected)) assert.strictEqual(C.verdict(co[id]), v, `defect colorado ${id}`);

// 3. Specific rules fire where the seeded rule should cause them
const rules = id => co[id].map(f => f.rule);
assert.ok(rules("F2").includes("STEER"), "F2 steering");
assert.ok(rules("D1").includes("FEES"), "D1 pet fees on assistance animal");
assert.ok(rules("N2").includes("DISC"), "N2 discouraging language");
assert.ok(rules("S3").includes("QUAL"), "S3 qualification differs");

// 4. Federal-only: source-of-income findings are informational, never high
const fed = run("defect", "federal");
for (const id of ["S1", "S2", "S3"]) {
  assert.ok(fed[id].length > 0, `${id} still recorded federally`);
  assert.ok(fed[id].every(f => f.severity === "info" && !f.inScope), `${id} informational under federal law`);
}

// 5. Extractor output is normalized defensively
const n = C.normFacts({ units: ["2B-204", "garbage"], nextStep: "teleport", qualifies: "maybe", fees: "x" });
assert.deepStrictEqual(n.units, ["2B-204"]);
assert.strictEqual(n.nextStep, "none");
assert.strictEqual(n.qualifies, "n/a");
assert.deepStrictEqual(n.fees, []);

console.log("All rule tests passed.");
