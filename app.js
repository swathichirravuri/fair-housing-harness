(function () {
  "use strict";
  const C = window.FHCore;
  const $ = s => document.querySelector(s);
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v; else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) n.append(k.nodeType ? k : document.createTextNode(String(k)));
    return n;
  };

  const VERDICT_LABEL = { pass: "Pass", fail: "Fail", review: "Review", info: "Info", pending: "Not run", running: "Running", error: "Error" };
  const DECISIONS = [
    { id: "confirm", label: "Confirm, open corrective action" },
    { id: "false_positive", label: "False positive" },
    { id: "legal", label: "Needs legal review" }
  ];

  const state = {
    cfg: "defect", jur: "colorado", mode: "recorded",
    results: {}, decisions: {}, reviewer: "", selected: "F2",
    run: null, running: false, ctl: null, sample: null, downloads: null, tab: "results"
  };
  try { state.reviewer = localStorage.getItem("fhh-reviewer") || ""; } catch (e) {}

  // ---------- Derived ----------
  function findingsFor(id) {
    const r = state.results[id];
    if (!r || r.status !== "done") return [];
    const pair = C.PAIRS.find(p => p.id === id);
    return C.compare(pair, r.control.facts, r.test.facts, state.jur);
  }
  function verdictFor(id) {
    const r = state.results[id];
    if (!r) return "pending";
    if (r.status !== "done") return r.status;
    return C.verdict(findingsFor(id));
  }
  function allFindings() { return C.PAIRS.flatMap(p => findingsFor(p.id)); }

  // ---------- Running ----------
  function runRecorded() {
    const rec = C.RECORDED[state.cfg];
    state.results = {};
    for (const p of C.PAIRS) state.results[p.id] = { status: "done", control: rec[p.id].control, test: rec[p.id].test, source: "recorded" };
    state.run = { mode: "recorded", cfg: state.cfg, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    state.decisions = {};
    setStatus("Recorded run loaded.");
    render();
  }

  const FATAL = new Set(["not_granted", "sampling_disabled", "not_declared", "capability_disabled", "capability_removed", "session_expired", "rate_limited"]);
  const ERR_COPY = {
    not_granted: "Claude access was not allowed for this page, so live runs are off. Recorded runs still work.",
    sampling_disabled: "Claude isn't available for this account here. Recorded runs still work.",
    rate_limited: "Too many requests right now. Wait a minute, then run again.",
    session_expired: "Your session expired. Sign in again, then run.",
    refused: "Claude declined to role-play this configuration for one pair.",
    invalid_json: "The fact extractor returned something unreadable for one pair.",
    upstream_error: "A connection problem interrupted one pair."
  };

  async function runLive() {
    if (!state.sample && !state.server) { toast("Live runs are not available on this page."); return; }
    state.running = true; state.ctl = new AbortController();
    const signal = state.ctl.signal;
    state.results = {}; state.decisions = {};
    for (const p of C.PAIRS) state.results[p.id] = { status: "pending" };
    state.run = { mode: "live", cfg: state.cfg, startedAt: new Date().toISOString() };
    renderControls(); render();
    let n = 0, stopped = null;
    for (const p of C.PAIRS) {
      if (signal.aborted) break;
      n++;
      state.results[p.id] = { status: "running" };
      setStatus(state.server ? `Running ${p.id} (${n} of ${C.PAIRS.length}) against a live model...` : `Running ${p.id} (${n} of ${C.PAIRS.length}). The first request asks you to allow Claude.`);
      render();
      try {
        if (state.server) {
          // Hosted: the server builds the prompts and holds the API key.
          const r = await fetch("/api/run", { method: "POST", signal, headers: { "content-type": "application/json" },
            body: JSON.stringify({ pairId: p.id, config: state.cfg }) });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) throw { code: r.status === 429 ? "rate_limited" : "server_error", message: data.error };
          state.results[p.id] = { status: "done", source: "live · " + (data.model || "model"), swapped: data.swapped,
            control: { text: data.control.text, facts: C.normFacts(data.control.facts) },
            test: { text: data.test.text, facts: C.normFacts(data.test.facts) } };
        } else {
          const opts = { signal, modelTier: "quick", cache: false };
          const [ctrlReply, testReply] = await Promise.all([
            state.sample(C.agentPrompt(state.cfg, p.control), opts),
            state.sample(C.agentPrompt(state.cfg, p.test), opts)
          ]);
          const swap = Math.random() < 0.5; // blind the extractor to which reply is which
          const a = swap ? testReply.text : ctrlReply.text, b = swap ? ctrlReply.text : testReply.text;
          const ex = await state.sample.json(C.extractionPrompt(a, b), { signal, modelTier: "quick" });
          const fa = C.normFacts(ex && ex.a), fb = C.normFacts(ex && ex.b);
          state.results[p.id] = { status: "done", source: "live", swapped: swap,
            control: { text: ctrlReply.text, facts: swap ? fb : fa },
            test: { text: testReply.text, facts: swap ? fa : fb } };
        }
      } catch (e) {
        if (e && e.name === "AbortError") { state.results[p.id] = { status: "pending" }; break; }
        if (e && e.code === "server_error") { state.results[p.id] = { status: "error", error: e.message || "The server could not run this pair." }; render(); continue; }
        const code = e && e.code;
        if (code === "cancelled") { state.results[p.id] = { status: "pending" }; break; }
        state.results[p.id] = { status: "error", error: ERR_COPY[code] || "Something went wrong on this pair." };
        if (FATAL.has(code)) { stopped = ERR_COPY[code] || "Live run stopped."; break; }
      }
      render();
    }
    state.run.finishedAt = new Date().toISOString();
    state.running = false; state.ctl = null;
    const done = C.PAIRS.filter(p => state.results[p.id].status === "done").length;
    setStatus(stopped || (signal.aborted ? `Stopped after ${done} pairs.` : `Live run finished: ${done} of ${C.PAIRS.length} pairs.`));
    renderControls(); render();
  }

  // ---------- Rendering ----------
  function setStatus(t) { $("#status").textContent = t; }
  let toastTimer;
  function toast(t) { const n = $("#toast"); n.textContent = t; n.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => n.hidden = true, 2600); }

  function renderControls() {
    $("#run").disabled = state.running;
    $("#run").textContent = state.mode === "live" ? "Run 12 pairs live" : "Run 12 paired tests";
    $("#stop").hidden = !state.running;
    document.querySelectorAll("#controls input").forEach(i => { if (i.name !== "jur") i.disabled = state.running; });
  }

  function renderSummary() {
    const s = $("#summary"); s.replaceChildren();
    const ran = C.PAIRS.filter(p => state.results[p.id] && state.results[p.id].status === "done");
    const f = allFindings();
    const high = f.filter(x => x.severity === "high").length, med = f.filter(x => x.severity === "medium").length, info = f.filter(x => x.severity === "info").length;
    const passed = ran.filter(p => verdictFor(p.id) === "pass").length;
    const v = !ran.length ? "pending" : high ? "fail" : med ? "review" : "pass";
    const vText = { pending: "No results yet", fail: "Differential treatment detected", review: "Differences need review", pass: "No differential treatment found" }[v];
    const cfgText = C.CONFIGS[state.run ? state.run.cfg : state.cfg].label;
    const fp = C.fingerprint(C.agentPrompt(state.run ? state.run.cfg : state.cfg, ""));
    s.append(
      el("div", { class: `verdict ${v}` }, el("span", { class: "k", text: "Verdict" }), el("span", { class: `v ${v}`, text: vText }),
        el("span", { class: "fp mono", text: `${cfgText} · config ${fp} · ${state.run && state.run.mode === "live" ? "live" : "recorded"}` })),
      el("div", null, el("span", { class: "k", text: "Pairs passed" }), el("span", { class: "v", text: `${passed}/${C.PAIRS.length}` })),
      el("div", null, el("span", { class: "k", text: "High findings" }), el("span", { class: "v" + (high ? " fail" : ""), text: high })),
      el("div", null, el("span", { class: "k", text: "Medium" }), el("span", { class: "v" + (med ? " review" : ""), text: med })),
      el("div", null, el("span", { class: "k", text: "Informational" }), el("span", { class: "v" + (info ? " info" : ""), text: info }))
    );
  }

  function renderRail() {
    const rail = $("#rail"); rail.replaceChildren();
    for (const [cls, meta] of Object.entries(C.CLASSES)) {
      const g = el("div", { class: "group" }, el("h3", { text: meta.label }));
      for (const p of C.PAIRS.filter(x => x.cls === cls)) {
        const v = verdictFor(p.id);
        g.append(el("button", { type: "button", class: "pairbtn", "aria-current": state.selected === p.id ? "true" : "false",
          onclick: () => { state.selected = p.id; renderRail(); renderDetail(); } },
          el("span", { class: "id", text: p.id }), el("span", { class: "fo", text: p.focus }),
          el("span", { class: `chip ${v === "error" ? "fail" : v}`, text: VERDICT_LABEL[v] })));
      }
      rail.append(g);
    }
  }

  function markDiff(text, other) {
    const otherWords = new Set(other.toLowerCase().match(/[\w'$,.-]+/g) || []);
    const frag = document.createDocumentFragment();
    for (const tok of text.split(/(\s+)/)) {
      const key = tok.toLowerCase().replace(/[?!]/g, "");
      if (tok.trim() && !otherWords.has(key) && !otherWords.has(tok.toLowerCase())) frag.append(el("span", { class: "cue", text: tok }));
      else frag.append(tok);
    }
    return frag;
  }

  function factRows(mine, other) {
    const rows = [
      ["Units offered", mine.units.length ? mine.units.join(", ") : "none", mine.units.slice().sort().join() !== other.units.slice().sort().join()],
      ["Special", mine.concession ? "mentioned" : "not mentioned", mine.concession !== other.concession],
      ["Fees quoted", mine.fees.length ? mine.fees.map(x => C.FEE_LABEL[x] || x).join(", ") : "none", mine.fees.slice().sort().join() !== other.fees.slice().sort().join()],
      ["Next step", C.STEP_LABEL[mine.nextStep] || mine.nextStep, mine.nextStep !== other.nextStep],
      ["Discouraging", mine.discouraging ? "yes" : "no", mine.discouraging !== other.discouraging],
      ["Qualifies", mine.qualifies, mine.qualifies !== other.qualifies]
    ];
    const dl = el("dl", { class: "facts" });
    for (const [k, v, d] of rows) dl.append(el("dt", { text: k }), el("dd", { class: d ? "diff" : null, text: v }));
    return dl;
  }

  function testerCard(role, pair, r) {
    const isTest = role === "test";
    const msg = isTest ? pair.test : pair.control, other = isTest ? pair.control : pair.test;
    const card = el("article", { class: "tester" },
      el("header", null, el("b", { text: isTest ? "Test tester" : "Control tester" }), el("span", { class: "role", text: isTest ? pair.cue : "No protected-class cue" })),
      el("div", { class: "msg prospect" }, el("span", { class: "who", text: "Prospect" }), el("p", null, markDiff(msg, other))));
    if (r && r.status === "done") {
      const mine = isTest ? r.test : r.control, theirs = isTest ? r.control : r.test;
      card.append(el("div", { class: "msg agent" }, el("span", { class: "who", text: `Agent reply · ${r.source}` }), el("p", { text: mine.text })), factRows(mine.facts, theirs.facts));
    } else {
      const t = !r || r.status === "pending" ? "Not run yet." : r.status === "running" ? "Waiting for the agent..." : (r.error || "No reply.");
      card.append(el("div", { class: "msg agent" }, el("p", { class: "empty", text: t })), el("div"));
    }
    return card;
  }

  function decisionControls(fid) {
    const cur = state.decisions[fid] || {};
    const wrap = el("div", { class: "review" }, el("span", { class: "lbl", text: "Reviewer" }));
    for (const d of DECISIONS) wrap.append(el("button", { type: "button", "aria-pressed": cur.decision === d.id ? "true" : "false",
      onclick: () => {
        if (!state.reviewer) { toast("Add your name in the Evidence ledger tab first."); }
        state.decisions[fid] = { ...cur, decision: cur.decision === d.id ? null : d.id, by: state.reviewer || null, at: new Date().toISOString() };
        renderDetail(); renderLedger();
      } }, d.label));
    wrap.append(el("input", { type: "text", id: `note-${fid}`, placeholder: "Rationale (kept in the evidence pack)", value: cur.note || "", "aria-label": "Rationale",
      onchange: e => { state.decisions[fid] = { ...(state.decisions[fid] || {}), note: e.target.value }; renderLedger(); } }));
    return wrap;
  }

  function renderDetail() {
    const d = $("#detail"); d.replaceChildren();
    const pair = C.PAIRS.find(p => p.id === state.selected);
    const r = state.results[pair.id];
    const v = verdictFor(pair.id);
    const cls = C.CLASSES[pair.cls];
    const inScope = pair.basis === "fha" || state.jur === "colorado";
    d.append(
      el("div", { class: "dhead" }, el("h2", { text: `${pair.id} · ${pair.focus}` }), el("span", { class: `chip ${v === "error" ? "fail" : v}`, text: VERDICT_LABEL[v] })),
      el("div", { class: "meta" },
        el("span", null, "Protected class ", el("b", { text: cls.label })),
        el("span", null, "Basis ", el("b", { text: cls.basis })),
        el("span", null, "Cue ", el("b", { text: pair.cue }))),
      el("div", { class: "testers" }, testerCard("control", pair, r), testerCard("test", pair, r))
    );
    if (!r || r.status !== "done") return;
    const fs = findingsFor(pair.id);
    const box = el("div", { class: "findings" }, el("h3", { text: fs.length ? `${fs.length} finding${fs.length > 1 ? "s" : ""}` : "Findings" }));
    if (!inScope) box.append(el("p", { class: "infonote", text: "Source of income is not a federal Fair Housing Act class. Under the current jurisdiction these differences are recorded as informational. Switch to Colorado to apply the state protection." }));
    if (!fs.length) {
      box.append(el("p", { class: "passnote", text: pair.id === "D2"
        ? "Both testers were treated the same. Parity passing here does not prove the accommodation was honored: a uniform failure would also pass. See Method and limits."
        : "Both testers were offered the same units, special, fees and next step." }));
    }
    for (const f of fs) {
      box.append(el("div", { class: `finding sev-${f.severity}` },
        el("div", { class: "ftop" }, el("span", { class: `chip ${f.severity === "info" ? "info" : f.severity}`, text: f.severity }), el("strong", { text: f.title }), el("span", { class: "fid", text: f.id })),
        el("p", { text: f.detail }),
        el("p", { class: "rulebox", text: `Rule ${f.rule}: ${C.RULES[f.rule].test}` }),
        el("div", { class: "refs" }, C.MAPPING.common.map(m => el("span", { class: "ref", title: m.name, text: `ISO ${m.ref}` }))),
        decisionControls(f.id)));
    }
    d.append(box);
  }

  function evidencePack() {
    const cfgId = state.run ? state.run.cfg : state.cfg;
    return {
      harness: "AuditMind Diagnose: Fair Housing Paired-Test Harness",
      notice: "Independent case study on a fictional property with a mock agent. Not affiliated with any vendor. Not legal advice.",
      generatedAt: new Date().toISOString(),
      reviewer: state.reviewer || null,
      run: { ...(state.run || {}), jurisdiction: state.jur, configuration: C.CONFIGS[cfgId].label, configFingerprint: C.fingerprint(C.agentPrompt(cfgId, "")) },
      property: C.PROPERTY,
      configurationRules: C.CONFIGS[cfgId].rules,
      rules: C.RULES,
      mapping: C.MAPPING,
      pairs: C.PAIRS.map(p => {
        const r = state.results[p.id] || {};
        return { id: p.id, protectedClass: C.CLASSES[p.cls].label, basis: C.CLASSES[p.cls].basis, cue: p.cue, status: r.status || "pending", verdict: verdictFor(p.id),
          control: { prospectMessage: p.control, reply: r.control ? r.control.text : null, facts: r.control ? r.control.facts : null },
          test: { prospectMessage: p.test, reply: r.test ? r.test.text : null, facts: r.test ? r.test.facts : null },
          findings: findingsFor(p.id).map(f => ({ ...f, review: state.decisions[f.id] || null })) };
      }),
      limitations: [
        "Detects differential treatment, not disparate impact.",
        "Uniform mistreatment of both testers passes parity checks.",
        "Live runs use one reply per tester; production use needs repeated trials.",
        "Findings are evidence for a qualified reviewer, not legal determinations."
      ]
    };
  }

  function renderLedger() {
    const v = $("#view-ledger"); v.replaceChildren();
    const fs = allFindings();
    const decided = fs.filter(f => state.decisions[f.id] && state.decisions[f.id].decision).length;
    const nameInput = el("input", { type: "text", id: "reviewer-name", placeholder: "Your name", value: state.reviewer, "aria-label": "Reviewer name",
      onchange: e => { state.reviewer = e.target.value.trim(); try { localStorage.setItem("fhh-reviewer", state.reviewer); } catch (er) {} } });
    const copyBtn = el("button", { type: "button", onclick: async () => {
      const txt = JSON.stringify(evidencePack(), null, 2);
      try { await navigator.clipboard.writeText(txt); toast("Evidence pack copied as JSON."); }
      catch (e) { toast("Copy was blocked in this view. Use Save instead."); }
    } }, "Copy evidence pack");
    const saveBtn = el("button", { type: "button", class: "primary", hidden: !state.downloads, onclick: async () => {
      try {
        await state.downloads.save({ filename: `fair-housing-evidence-${new Date().toISOString().slice(0, 10)}.json`, data: JSON.stringify(evidencePack(), null, 2) });
        toast("Evidence pack saved.");
      } catch (e) { if (e && e.code !== "declined") toast("Saving isn't available here. Use Copy instead."); }
    } }, "Save evidence pack (.json)");
    v.append(
      el("div", { class: "toolbar" },
        el("div", { class: "reviewer" }, el("label", { for: "reviewer-name", class: "note", text: "Accountable reviewer" }), nameInput),
        el("span", { class: "note", text: `${decided} of ${fs.length} findings decided` }),
        el("span", { style: "flex:1" }), copyBtn, saveBtn));

    const t = el("table", null, el("thead", null, el("tr", null, ["Finding", "Class", "Rule", "Severity", "Decision", "Rationale"].map(h => el("th", { text: h })))));
    const tb = el("tbody");
    if (!fs.length) tb.append(el("tr", null, el("td", { colspan: "6", class: "empty", text: "No findings in this run. The ledger still records every pair, reply and extracted fact in the evidence pack." })));
    for (const f of fs) {
      const dec = state.decisions[f.id] || {};
      const dl = DECISIONS.find(x => x.id === dec.decision);
      tb.append(el("tr", null,
        el("td", { class: "mono" }, el("a", { href: "#", onclick: e => { e.preventDefault(); state.selected = f.pair; setTab("results"); renderRail(); renderDetail(); } }, f.id)),
        el("td", { text: C.CLASSES[f.cls].label }), el("td", { text: f.title }),
        el("td", null, el("span", { class: `chip ${f.severity === "info" ? "info" : f.severity}`, text: f.severity })),
        el("td", { text: dl ? `${dl.label}${dec.by ? " · " + dec.by : ""}` : "Open" }),
        el("td", { text: dec.note || "" })));
    }
    t.append(tb);
    v.append(el("div", { class: "tablewrap" }, t));

    const m = el("table", null, el("thead", null, el("tr", null, ["ISO/IEC 42001", "Control", "What this harness provides"].map(h => el("th", { text: h })))),
      el("tbody", null, C.MAPPING.common.map(x => el("tr", null, el("td", { class: "mono", text: x.ref }), el("td", { text: x.name }), el("td", { text: x.use })))));
    const pr = el("table", null, el("thead", null, el("tr", null, ["Published trusted-AI principle", "Evidence produced"].map(h => el("th", { text: h })))),
      el("tbody", null, C.MAPPING.principles.map(x => el("tr", null, el("td", { text: x.name }), el("td", { text: x.use })))));
    v.append(el("div", { class: "cols2" }, el("div", { class: "tablewrap" }, m), el("div", { class: "tablewrap" }, pr)));
    v.append(el("p", { class: "note", text: "Principles column paraphrases a rental-housing vendor's published trusted-AI framework and shows how a test harness turns each commitment into a record an auditor can check." }));
  }

  function renderConfig() {
    const v = $("#view-config"); v.replaceChildren();
    const cfg = C.CONFIGS[state.cfg];
    const sample = C.PAIRS.find(p => p.id === state.selected);
    v.append(el("div", { class: "cols2" },
      el("div", { class: "card" }, el("h2", { text: cfg.label }), el("p", { class: "note", text: cfg.summary }),
        el("ol", null, cfg.rules.map(x => el("li", { text: x })))),
      el("div", { class: "card" }, el("h2", { text: C.PROPERTY.name }), el("p", { class: "note", text: C.PROPERTY.location }),
        el("div", { class: "tablewrap" }, el("table", null,
          el("thead", null, el("tr", null, ["Unit", "Rent", "Available", "Notes"].map(h => el("th", { text: h })))),
          el("tbody", null, C.PROPERTY.units.map(u => el("tr", null, el("td", { class: "mono", text: u.id }), el("td", { class: "mono", text: `$${u.rent.toLocaleString()}` }), el("td", { text: u.available }), el("td", { text: u.notes })))))),
        el("ul", null, C.PROPERTY.policies.map(x => el("li", { text: x }))))),
      el("div", { class: "card" }, el("h2", { text: `Exact prompt sent for ${sample.id}, test tester` }),
        el("p", { class: "note", text: "Live runs send this to Claude for each tester. The fact extractor gets only the two replies, in random order, without the prospect messages." }),
        el("pre", { text: C.agentPrompt(state.cfg, sample.test) })));
  }

  function setTab(name) {
    state.tab = name;
    for (const t of ["results", "ledger", "config", "method"]) {
      $(`#tab-${t}`).setAttribute("aria-selected", t === name ? "true" : "false");
      $(`#view-${t}`).hidden = t !== name;
    }
    if (name === "config") renderConfig();
    if (name === "ledger") renderLedger();
    try { history.replaceState(null, "", "#" + name); } catch (e) {}
  }

  function render() { renderSummary(); renderRail(); renderDetail(); if (state.tab === "ledger") renderLedger(); if (state.tab === "config") renderConfig(); }

  // ---------- Events ----------
  $("#controls").addEventListener("change", e => {
    const t = e.target;
    if (t.name === "jur") { state.jur = t.value; render(); return; }
    if (t.name === "cfg") state.cfg = t.value;
    if (t.name === "mode") state.mode = t.value;
    renderControls();
    if (state.mode === "recorded") runRecorded();
    else { setStatus("Live mode: press Run. Each pair makes three Claude requests on your account."); if (state.tab === "config") renderConfig(); }
  });
  $("#controls").addEventListener("submit", e => { e.preventDefault(); state.mode === "live" ? runLive() : runRecorded(); });
  $("#stop").addEventListener("click", () => state.ctl && state.ctl.abort());
  for (const t of ["results", "ledger", "config", "method"]) $(`#tab-${t}`).addEventListener("click", () => setTab(t));

  // ---------- Boot ----------
  runRecorded();
  renderControls();
  const h = (location.hash || "").slice(1);
  if (["ledger", "config", "method"].includes(h)) setTab(h);
  setStatus("Recorded run of the seeded-defect agent. Switch agent or jurisdiction to compare.");

  $("#mode-live").disabled = true;
  if (window.claude && window.claude.use) {
    window.claude.use("sample").then(s => { state.sample = s; $("#mode-live").disabled = !s; }).catch(() => {});
    window.claude.use("downloads").then(dl => { state.downloads = dl; if (state.tab === "ledger") renderLedger(); }).catch(() => {});
  } else {
    // Hosted (e.g. Vercel): live runs go through /api/run when the deployment has an API key.
    const lbl = document.querySelector('label[for="mode-live"]');
    fetch("/api/health", { cache: "no-store" }).then(r => r.ok ? r.json() : null).then(h => {
      if (h && h.live) {
        state.server = true;
        $("#mode-live").disabled = false;
        if (lbl) lbl.textContent = "Live model run";
      } else if (lbl) { lbl.title = "Live runs are not configured on this deployment."; lbl.textContent = "Live (not configured)"; }
    }).catch(() => { if (lbl) lbl.textContent = "Live (not configured)"; });
    // Make the default view honest about what recorded means.
    const rec = document.querySelector('label[for="mode-rec"]');
    if (rec) rec.textContent = "Recorded example";
  }
})();
