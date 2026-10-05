// quota-fit (round 27b) — the calibration math, pinned on synthetic rows
// whose true constants are known by construction: CAP=1M credits/5h,
// 1 fresh-input token = 1 credit, output = 4 credits/tok, cache-read =
// 0.25 credits/tok. The fit must recover those (and only those).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  parseRow,
  pairDeltas,
  lstsq,
  fitFreeWeights,
  fitHypothesis,
  formatReport,
  splitSpans,
  main,
} from "../tools/quota-fit.mjs";

const row = (ts, q, inTok, outTok, cr, resetAt = "2026-10-05T09:10:44.917Z") =>
  parseRow({ ts, q_pct: q, reset_at: resetAt, tok: { in: inTok, out: outTok, cr, cc: 0 } });

const CAP = 1_000_000; // credits per 5h
const K_IN = 1 / CAP; // fraction of window per fresh-input token
const K_OUT = 4 / CAP;
const K_CR = 0.25 / CAP;

// Ten rows burning mixed classes, no aging-out (mid-window), no noise.
const mkRows = () => {
  const rows = [];
  let inT = 1_000_000;
  let outT = 100_000;
  let crT = 20_000_000;
  let q = 10;
  for (let i = 0; i < 10; i++) {
    // quasi-random independent variation (affine-in-i deltas make the whole
    // design rank-2 — every column would be a combo of {1, i})
    const dIn = Math.round(120_000 * (0.7 + ((i * 7) % 11) / 20));
    const dOut = Math.round(8_000 * (0.7 + ((i * 5) % 13) / 25));
    const dCr = Math.round(900_000 * (0.6 + ((i * 3) % 17) / 20));
    inT += dIn;
    outT += dOut;
    crT += dCr;
    q += (dIn * K_IN + dOut * K_OUT + dCr * K_CR) * 100;
    rows.push(row(`2026-10-05T0${6 + Math.floor(i / 10)}:${String(3 + i).padStart(2, "0")}:00Z`, q, inT, outT, crT)); // exact q — integer quantization is a LIVE-data property, not this pin's
  }
  return rows;
};

test("parseRow: accepts ts string or epoch ms, rejects tok-less rows", () => {
  assert.equal(parseRow({ ts: "2026-10-05T06:03:00Z", q_pct: 30, tok: { in: 1, out: 1, cr: 1 } }).in, 1);
  assert.equal(parseRow({ ts: 1759600000000, q_pct: 30, tok: { in: 1, out: 1, cr: 1 } }).ts, 1759600000000);
  assert.equal(parseRow({ ts: "2026-10-05T06:03:00Z", q_pct: 30 }), null, "no tok sums → unusable");
  assert.equal(parseRow({ q_pct: 30, tok: { in: 1, out: 1, cr: 1 } }), null, "no timestamp → unusable");
  assert.equal(parseRow(null), null);
});

test("pairDeltas: flags reset pairs, skips tok-less neighbors", () => {
  const rows = [
    row("2026-10-05T06:00:00Z", 10, 1000, 100, 10_000),
    row("2026-10-05T06:10:00Z", 11, 2000, 200, 20_000),
    { ts: Date.parse("2026-10-05T06:20:00Z"), q: 12, in: null, out: null, cr: null, resetAt: "2026-10-05T09:10:44.917Z" },
    row("2026-10-05T06:30:00Z", 13, 4000, 400, 40_000),
    row("2026-10-05T06:40:00Z", 40, 5000, 500, 50_000, "2026-10-05T14:10:44.917Z"), // reset_at moved
  ];
  const pairs = pairDeltas(rows);
  assert.equal(pairs.length, 2, "the tok-less row kills both of its pairs");
  assert.equal(pairs[0].isReset, false);
  assert.equal(pairs[1].isReset, true, "reset_at discontinuity is a different experiment");
  assert.equal(pairs[0].dq, 0.01, "deltas are fractions, not points");
});

test("free weights recover the constructed constants", () => {
  const fit = fitFreeWeights(pairDeltas(mkRows()));
  assert.ok(fit, "10 steady pairs is enough for 4 params");
  const [, bIn, bOut, bCr] = fit.beta;
  assert.ok(Math.abs(bIn - K_IN) / K_IN < 0.02, `k_in ~1/CAP (got ${bIn})`);
  assert.ok(Math.abs(bOut - K_OUT) / K_OUT < 0.02, `k_out ~4/CAP (got ${bOut})`);
  assert.ok(Math.abs(bCr - K_CR) / K_CR < 0.02, `k_cr ~0.25/CAP (got ${bCr})`);
  assert.ok(fit.r2 > 0.999, "noiseless construction → near-perfect R²");
  assert.ok(Math.abs(fit.beta[0]) < K_IN * 50_000, "intercept ~0 when there is no peer drift");
});

test("hypothesis fit: right crMult nails CAP, wrong one does not", () => {
  const pairs = pairDeltas(mkRows());
  const right = fitHypothesis(pairs, 0.25);
  assert.ok(Math.abs(right.impliedCap - CAP) / CAP < 0.02, `CAP recovered (got ${right.impliedCap})`);
  const zero = fitHypothesis(pairs, 0);
  assert.ok(Math.abs(zero.impliedCap - CAP) / CAP > 0.1, "cache-free weighting misstates CAP by >10%");
  assert.ok(right.r2 > zero.r2, "the true weighting fits better");
});

test("reset pairs are excluded from every fit", () => {
  const rows = mkRows();
  rows.push(row("2026-10-05T07:00:00Z", 2, 2_500_000, 250_000, 30_000_000, "2026-10-05T14:10:44.917Z"));
  const fit = fitFreeWeights(pairDeltas(rows));
  const [, bIn] = fit.beta;
  assert.ok(Math.abs(bIn - K_IN) / K_IN < 0.02, "the -30pt reset jump never touches the slopes");
});

test("insufficient rows degrade honestly", () => {
  const short = [row("2026-10-05T06:00:00Z", 10, 1000, 100, 10_000), row("2026-10-05T06:10:00Z", 11, 2000, 200, 20_000)];
  assert.equal(fitFreeWeights(pairDeltas(short)), null, "1 steady pair cannot fit 4 params");
  const report = formatReport(short, pairDeltas(short), null, [fitHypothesis(pairDeltas(short), 0.25)]);
  assert.match(report, /insufficient rows/);
});

test("report refuses to bless unstable signs as quotable", () => {
  // Two pairs of noisy integer q — enough rows to fit, garbage signs.
  const noisy = [
    row("2026-10-05T06:00:00Z", 10, 1_000_000, 100_000, 20_000_000),
    row("2026-10-05T06:10:00Z", 10, 1_200_000, 110_000, 21_000_000),
    row("2026-10-05T06:20:00Z", 11, 1_300_000, 120_000, 21_500_000),
    row("2026-10-05T06:30:00Z", 10, 1_500_000, 130_000, 22_500_000),
    row("2026-10-05T06:40:00Z", 12, 1_600_000, 140_000, 23_000_000),
    row("2026-10-05T06:50:00Z", 11, 1_700_000, 150_000, 24_000_000), // 6th row → 5 pairs, just enough to fit
  ];
  const pairs = pairDeltas(noisy);
  const fit = fitFreeWeights(pairs);
  const report = formatReport(noisy, pairs, fit, []);
  // r28 L9: the scaled solver correctly REFUSES this design — its three
  // smoothly-increasing token columns are quasi-collinear at machine
  // precision, which the unscaled pivot test papered over with garbage
  // signs. Either way the contract holds: labeled or refused, never
  // presented as quotable constants.
  assert.match(report, /PROVISIONAL|insufficient rows/, "small-n or wrong-sign output is labeled or refused, never presented as constants");
});

test("lstsq: collinear regressors refuse instead of garbage", () => {
  const X = [
    [1, 2, 4],
    [1, 3, 6],
    [1, 4, 8],
    [1, 5, 10],
  ]; // col 2 = 2×col 1 → singular
  assert.equal(lstsq(X, [1, 2, 3, 4]), null);
});

test("lstsq: live-magnitude collinear design still refuses (r28 L9 scaling)", () => {
  // dIn ~1e5-1e6, dCr ~1e8-1e9 — the scale real rows produce, where XᵀX
  // entries approach 1e18 and unscaled roundoff pivots at ~1e2: a truly
  // collinear column (col3 = 2×col1) used to sail through the 1e-12 pivot
  // test and return garbage betas instead of the refusal. Scaled columns
  // put the pivot test back where its threshold means something.
  const X = [];
  const y = [];
  for (let i = 0; i < 8; i++) {
    const dIn = 120_000 * (1 + (i % 3));
    const dOut = 30_000 * (1 + (i % 4));
    X.push([1, dIn, dOut, 2 * dIn]); // col 3 = 2×col 1 → collinear
    y.push(0.01 + 0.002 * (i % 3));
  }
  assert.equal(lstsq(X, y), null);
});

// r28 audit follow-ups: the strict q_pct guard, the n≥10 sign arm, and the
// --json provisional field — none of which the original suite exercised.
test("parseRow: null q_pct is dropped, never read as 0% (r28 H1)", () => {
  // A failed provider poll beside a successful token scan writes q_pct:null
  // with a live tok object. Number(null)===0 — without the strict guard that
  // row enters the fit as a fake drain-then-refill pair.
  const nullQ = parseRow({ ts: "2026-10-05T06:00:00Z", q_pct: null, reset_at: "2026-10-05T09:10:44.917Z", tok: { in: 1_000_000, out: 100_000, cr: 20_000_000, cc: 0 } });
  assert.equal(nullQ, null);
  // strictness contract: only real numbers are readings (numeric strings drop too)
  const strQ = parseRow({ ts: "2026-10-05T06:00:00Z", q_pct: "14", reset_at: "x", tok: { in: 1, out: 1, cr: 1, cc: 0 } });
  assert.equal(strQ, null);
  // real rows still pass
  assert.equal(parseRow({ ts: "2026-10-05T06:00:00Z", q_pct: 14, reset_at: "x", tok: { in: 1, out: 1, cr: 1, cc: 0 } }).q, 14);
});

test("PROVISIONAL sign arm fires at n≥10 (not just the small-n arm) (r28 M4)", () => {
  // q driven by output MINUS a slice of cache — a synthetic negative cache
  // weight, deterministic by construction. At 10 steady pairs the small-n arm
  // stays quiet; only the non-positive-weight arm can label this fit.
  const t0 = Date.parse("2026-10-05T06:00:00Z");
  const rows = [];
  let inT = 1_000_000;
  let outT = 100_000;
  let crT = 20_000_000;
  let q = 10;
  for (let i = 0; i < 11; i++) {
    const dIn = Math.round(120_000 * (0.7 + ((i * 7) % 11) / 20));
    const dOut = Math.round(8_000 * (0.7 + ((i * 5) % 13) / 25));
    const dCr = Math.round(900_000 * (0.6 + ((i * 3) % 17) / 20));
    inT += dIn;
    outT += dOut;
    crT += dCr;
    q += (dOut * K_OUT - (dCr * K_CR) / 4) * 100;
    rows.push(row(new Date(t0 + i * 600_000).toISOString(), q, inT, outT, crT));
  }
  const pairs = pairDeltas(rows);
  assert.ok(pairs.filter((p) => !p.isReset).length >= 10, "test design: enough steady pairs to leave the small-n arm behind");
  const fit = fitFreeWeights(pairs);
  assert.ok(fit.beta.slice(1).some((b) => b <= 0), "test design: a weight really is non-positive here");
  const report = formatReport(rows, pairs, fit, []);
  assert.match(report, /PROVISIONAL — non-positive weight/);
  assert.doesNotMatch(report, /PROVISIONAL — only \d+ steady pairs/);
});

test("--json: provisional flag labels a sign-unstable fit (r28 M4)", () => {
  const t0 = Date.parse("2026-10-05T06:00:00Z");
  const raw = [];
  let inT = 1_000_000;
  let outT = 100_000;
  let crT = 20_000_000;
  let q = 10;
  for (let i = 0; i < 11; i++) {
    const dIn = Math.round(120_000 * (0.7 + ((i * 7) % 11) / 20));
    const dOut = Math.round(8_000 * (0.7 + ((i * 5) % 13) / 25));
    const dCr = Math.round(900_000 * (0.6 + ((i * 3) % 17) / 20));
    inT += dIn;
    outT += dOut;
    crT += dCr;
    q += (dOut * K_OUT - (dCr * K_CR) / 4) * 100;
    raw.push({ at: new Date(t0 + i * 600_000).toISOString(), q_pct: q, reset_at: "2026-10-05T09:10:44.917Z", tok: { in: inT, out: outT, cr: crT, cc: 0 } });
  }
  const tmp = `/tmp/quota-fit-json-test-${process.pid}.jsonl`;
  fs.writeFileSync(tmp, raw.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const logged = [];
  const orig = console.log;
  console.log = (s) => logged.push(s);
  try {
    main(["--json", tmp]);
  } finally {
    console.log = orig;
    fs.rmSync(tmp, { force: true });
  }
  const out = JSON.parse(logged[0]);
  assert.equal(out.steadyPairs, 10);
  assert.equal(out.provisional, true);
});

test("splitSpans: breaks exactly where reset_at changes, null never splits (r28 M3)", () => {
  const A = "2026-10-05T09:10:44.917Z";
  const B = "2026-10-05T14:10:45.872Z";
  const r = (ts, resetAt) => parseRow({ ts, q_pct: 10, reset_at: resetAt, tok: { in: 1, out: 1, cr: 1, cc: 0 } });
  const spans = splitSpans([r("2026-10-05T05:00:00Z", A), r("2026-10-05T05:10:00Z", A), r("2026-10-05T05:20:00Z", A), r("2026-10-05T09:20:00Z", B), r("2026-10-05T09:30:00Z", B)]);
  assert.equal(spans.length, 2);
  assert.equal(spans[0].length, 3);
  assert.equal(spans[1].length, 2);
  assert.equal(splitSpans([r("2026-10-05T05:00:00Z", A), r("2026-10-05T05:10:00Z", A)]).length, 1);
  // null resetAt splits on both sides (same !== boundary pairDeltas uses) —
  // the null row lands as a singleton and drops out of fitting, exactly like
  // the old isReset exclusion
  const withNull = splitSpans([r("2026-10-05T05:00:00Z", A), r("2026-10-05T05:10:00Z", null), r("2026-10-05T05:20:00Z", B)]);
  assert.equal(withNull.length, 3);
  assert.deepEqual(withNull.map((s) => s.length), [1, 1, 1]);
});

test("--json spans: each anchor window fitted alone; newest is the headline (r28 M3)", () => {
  const OLD = "2026-10-05T09:10:44.917Z";
  const NEW = "2026-10-05T14:10:45.872Z";
  const raw = [];
  // OLD span: 11 rows (10 steady pairs — the quotable threshold) burning all
  // three classes with the suite's true constants — quotable by construction
  // (the morning-window shape).
  let inT = 1_000_000;
  let outT = 100_000;
  let crT = 20_000_000;
  let q = 10;
  for (let i = 0; i < 11; i++) {
    const dIn = Math.round(120_000 * (0.7 + ((i * 7) % 11) / 20));
    const dOut = Math.round(8_000 * (0.7 + ((i * 5) % 13) / 25));
    const dCr = Math.round(900_000 * (0.6 + ((i * 3) % 17) / 20));
    inT += dIn;
    outT += dOut;
    crT += dCr;
    q += (dIn * K_IN + dOut * K_OUT + dCr * K_CR) * 100;
    raw.push({ at: new Date(Date.parse("2026-10-05T05:00:00Z") + i * 600_000).toISOString(), q_pct: q, reset_at: OLD, tok: { in: inT, out: outT, cr: crT, cc: 0 } });
  }
  // NEW span: 3 rows — too few to fit (the post-reset shape).
  for (let i = 0; i < 3; i++) {
    inT += 50_000;
    outT += 4_000;
    crT += 400_000;
    q += 1;
    raw.push({ at: new Date(Date.parse("2026-10-05T09:20:00Z") + i * 600_000).toISOString(), q_pct: q, reset_at: NEW, tok: { in: inT, out: outT, cr: crT, cc: 0 } });
  }
  const tmp = `/tmp/quota-fit-spans-test-${process.pid}.jsonl`;
  fs.writeFileSync(tmp, raw.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const logged = [];
  const orig = console.log;
  console.log = (s) => logged.push(s);
  try {
    main(["--json", tmp]);
  } finally {
    console.log = orig;
    fs.rmSync(tmp, { force: true });
  }
  const out = JSON.parse(logged[0]);
  assert.equal(out.spans.length, 2);
  assert.equal(out.resetPairs, 1, "the span boundary is still visible as a reset pair");
  // headline = NEWEST span: 2 steady pairs, unfittable → provisional
  assert.equal(out.provisional, true);
  assert.equal(out.free, null);
  // OLD span fitted alone and quotable: k_out recovers 4 credits/tok within 2%
  assert.equal(out.spans[0].provisional, false);
  const kOutPtsPerMtok = out.spans[0].free.kOut * 1e6 * 100;
  assert.ok(Math.abs(kOutPtsPerMtok - K_OUT * 1e6 * 100) / (K_OUT * 1e6 * 100) < 0.02, `k_out ${kOutPtsPerMtok} vs true ${K_OUT * 1e6 * 100}`);
  assert.equal(out.spans[1].provisional, true);
});
