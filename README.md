# Fair Housing Paired-Test Harness

**An assurance layer for AI leasing agents in property management software.** Two simulated prospects send the same message to an AI leasing agent. The only difference is one protected-class cue. The harness compares what each was offered and turns every difference into ISO/IEC 42001 evidence that a named reviewer must sign off.

Part of the **AuditMind "Diagnose"** layer of the AI Trust Stack. Built by Swathi, AI Product Manager (AIGP).

> Independent case study on a fictional property with a mock agent. Not affiliated with or tested against any real property management or leasing product. Not legal advice.

## The problem

Rental housing platforms are moving from chatbots to autonomous agents. A leasing agent that resolves most routine prospect inquiries without a human is now a fair housing surface: if it offers different units, specials, fees or tour access because a prospect mentions children, a disability, an accent cue or a voucher, that is differential treatment, at scale, and the property manager deploying it carries the exposure.

Vendors have published trusted-AI principles ("show its work", "logged and auditable", "a person is accountable"). Principles are commitments. Auditors, customers and regulators need **evidence**.

## What the harness does

1. **Matched pairs.** 12 pairs across familial status, disability, national origin and source of income, following HUD's paired-testing method.
2. **Same agent, same facts.** Both messages go to the same agent configuration on the same property.
3. **Blind fact extraction.** An extractor reads each reply without seeing the prospect message and records units offered, special mentioned, fees quoted, next step, discouraging language and qualification answer.
4. **Deterministic rules.** Fixed, inspectable rules compare the two fact sets (steering, fewer units, special withheld, extra fees, qualification differs, discouraging language, harder path to tour). The model never decides what counts as discrimination.
5. **Evidence and accountability.** Each finding maps to ISO/IEC 42001 (Cl. 6.1.4/8.4, A.5.4, A.6.2.4, A.6.2.8, Cl. 10.2) and waits for a named reviewer decision. The full run exports as a JSON evidence pack.

### Why a seeded defect

A harness that only shows green proves nothing. The seeded configuration holds five rules that read like ordinary operations guidance ("route voucher applications to the manager", "families prefer the ground floor"). Each produces differential treatment. The harness catches 9 of 12 pairs and passes all 12 on the compliant agent. That is also the product insight: steering usually enters a system through configuration, not intent.

### Why source of income is switchable

Source of income is not a federal Fair Housing Act class. Many states and cities protect it, Colorado among them. Under "Federal FHA only" those findings are informational, so one suite serves properties in different jurisdictions.

## Known limits

- Detects differential treatment, not disparate impact (that needs outcome data across real applicants).
- A uniform failure passes parity (pair D2 shows this; it needs an accommodation-policy check).
- Live runs take one reply per tester; production needs repeated trials per pair.
- Findings are evidence for a qualified reviewer, not legal determinations.
- ISO clause references follow ISO/IEC 42001:2023; verify against a licensed copy before citing in an audit.

## Run it

Static site, no build step.

```bash
npx serve .        # or open index.html directly
npm test           # rule tests: compliant passes, every seeded defect is caught
```

Hosted demo uses recorded agent runs. Live runs (agent and extractor calls to an LLM) work when opened inside Claude; a hosted version needs a small API route.

## Files

| File | What it holds |
|---|---|
| `index.html` | Page and styles |
| `core.js` | Property, agent configs, 12 matched pairs, recorded runs, comparison rules, ISO mapping |
| `app.js` | UI, live-run orchestration, reviewer decisions, evidence pack export |
| `test/rules.test.js` | Rule tests |
