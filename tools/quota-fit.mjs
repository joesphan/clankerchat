#!/usr/bin/env node
// quota-fit — phase 2 of the quota calibration (rounds 24-25).
//
// quota-history.jsonl rows pair the provider's own q_pct (5h window, % of
// limit) with OUR transcript token-class sums over the same rolling window
// (scanTokenUsage). This tool fits the missing link: how much q_pct each
// token class costs, and what absolute cap those weights imply — settling
// the report #2 (cache=25% of fresh) vs report #3 (10%) contradiction from
// our own telemetry instead of vendor docs.
//
// Method: DELTA regression, not levels. Both the provider's window and our
// scan age out over the same rolling 5h, so consecutive-row deltas satisfy
//   Δq = (Δin·k_in + Δout·k_out + Δcr·k_cr + peer drift)/CAP + noise
// — the peer machine's roughly-constant burn lands in the intercept, not
// the slopes. Rows spanning a reset_at change are a different experiment
// (the window DRAINS) and are excluded from the fit but reported.
//
// Honest limits, stated in the report: q_pct is integer-grained (±0.5pt
// noise per row), the peer share varies in reality, and cc (cache-creation)
// is 0 on this backend so it is dropped from the fit. Zero prompts — pure
// local math over the history file.
//
// Usage: npm run quota-fit [-- /path/quota-history.jsonl]

import fs from "node:fs";
import path from "node:path";

/** Shape of one history row (subset this tool reads). */
export function parseRow(obj) {
  if (!obj || typeof obj !== "object") return null;
  const tsRaw = obj.at ?? obj.ts; // live rows stamp `at`; accept both
  const ts = typeof tsRaw === "string" ? Date.parse(tsRaw) : Number(tsRaw);
  const q = Number(obj.q_pct);
  const tok = obj.tok && typeof obj.tok === "object" ? obj.tok : null;
  if (!Number.isFinite(ts) || !Number.isFinite(q) || !tok) return null;
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    ts,
    q, // percent
    in: num(tok.in),
    out: num(tok.out),
    cr: num(tok.cr),
    resetAt: typeof obj.reset_at === "string" ? obj.reset_at : null,
  };
}

/** Consecutive-row deltas; pairs lacking tok sums or spanning a reset are
 *  flagged, never silently mixed into the steady-state fit. */
export function pairDeltas(rows) {
  const pairs = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (a.in === null || b.in === null || a.cr === null || b.cr === null || a.out === null || b.out === null) continue;
    pairs.push({
      dtMin: (b.ts - a.ts) / 60_000,
      dq: (b.q - a.q) / 100, // fraction, not points
      dIn: b.in - a.in,
      dOut: b.out - a.out,
      dCr: b.cr - a.cr,
      isReset: a.resetAt !== b.resetAt,
    });
  }
  return pairs;
}

/** Least squares y ~ 1 + x1..xn via normal equations + Gaussian elimination
 *  with partial pivoting. Returns {beta: [b0..bn], r2, n}. */
export function lstsq(X, y) {
  const n = y.length;
  const p = X[0].length;
  if (n < p + 1) return null; // underdetermined — caller decides how to report
  // normal equations A = XᵀX, b = Xᵀy (X rows carry the implicit leading 1)
  const A = Array.from({ length: p }, () => new Array(p + 1).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < p; j++) {
      for (let k = j; k < p; k++) A[j][k] += X[i][j] * X[i][k];
      A[j][p] += X[i][j] * y[i];
    }
  }
  for (let j = 0; j < p; j++) for (let k = 0; k < j; k++) A[j][k] = A[k][j];
  // Gaussian elimination with partial pivoting
  for (let col = 0; col < p; col++) {
    let piv = col;
    for (let r = col + 1; r < p; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null; // singular (collinear classes)
    [A[col], A[piv]] = [A[piv], A[col]];
    for (let r = col + 1; r < p; r++) {
      const f = A[r][col] / A[col][col];
      for (let c = col; c <= p; c++) A[r][c] -= f * A[col][c];
    }
  }
  const beta = new Array(p).fill(0);
  for (let r = p - 1; r >= 0; r--) {
    let s = A[r][p];
    for (let c = r + 1; c < p; c++) s -= A[r][c] * beta[c];
    beta[r] = s / A[r][r];
  }
  const mean = y.reduce((s, v) => s + v, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    let pred = 0;
    for (let j = 0; j < p; j++) pred += X[i][j] * beta[j];
    ssRes += (y[i] - pred) ** 2;
    ssTot += (y[i] - mean) ** 2;
  }
  return { beta, r2: ssTot > 0 ? 1 - ssRes / ssTot : null, n };
}

/** Free-weight fit: dq ~ 1 + dIn + dOut + dCr (fraction per token). */
export function fitFreeWeights(pairs) {
  const steady = pairs.filter((p) => !p.isReset);
  return lstsq(
    steady.map((p) => [1, p.dIn, p.dOut, p.dCr]),
    steady.map((p) => p.dq),
  );
}

/** Constrained fit under a named cache hypothesis: cache-read bills at
 *  crMult × fresh input. Regress dq ~ 1 + z + dOut with z = dIn + crMult·dCr;
 *  implied CAP (in "credits" where 1 fresh-input token = 1 credit) = 1/β_z. */
export function fitHypothesis(pairs, crMult) {
  const steady = pairs.filter((p) => !p.isReset);
  const fit = lstsq(
    steady.map((p) => [1, p.dIn + crMult * p.dCr, p.dOut]),
    steady.map((p) => p.dq),
  );
  if (!fit) return null;
  const [b0, bz, bo] = fit.beta;
  return {
    crMult,
    kIn: bz, // fraction per fresh-input token
    kOut: bo,
    intercept: b0,
    r2: fit.r2,
    n: fit.n,
    impliedCap: bz > 0 ? 1 / bz : null, // credits per 5h, 1 credit = 1 input tok
  };
}

const fmtCap = (cap) => (cap === null ? "n/a" : `${(cap / 1e6).toFixed(1)}M credits/5h (1 credit = 1 fresh-input tok)`);

export function formatReport(rows, pairs, freeFit, hyps) {
  const lines = [];
  const first = rows[0];
  const last = rows[rows.length - 1];
  lines.push(`quota-fit — ${rows.length} rows, ${new Date(first.ts).toISOString()} → ${new Date(last.ts).toISOString()}`);
  lines.push(`  steady pairs: ${pairs.filter((p) => !p.isReset).length}, reset pairs (excluded from fit): ${pairs.filter((p) => p.isReset).length}`);
  for (const p of pairs.filter((x) => x.isReset)) {
    lines.push(`  RESET EVENT ${p.dtMin.toFixed(0)}min: Δq ${(p.dq * 100).toFixed(0)}pts — window drained (natural experiment; needs both machines idle to read as a cap measurement)`);
  }
  if (freeFit) {
    const [, bIn, bOut, bCr] = freeFit.beta;
    const unstable = bIn <= 0 || bOut <= 0 || bCr <= 0;
    if (freeFit.n < 10 || unstable) {
      lines.push(`PROVISIONAL — ${freeFit.n < 10 ? `only ${freeFit.n} steady pairs (<10)` : "non-positive weight(s)"}: signs are not settled, do not quote these as constants`);
    }
    lines.push(`free weights (R²=${freeFit.r2 === null ? "n/a" : freeFit.r2.toFixed(3)}, n=${freeFit.n}):`);
    lines.push(`  k_in  = ${(bIn * 1e6 * 100).toFixed(3)} pts/Mtok`);
    lines.push(`  k_out = ${(bOut * 1e6 * 100).toFixed(3)} pts/Mtok`);
    lines.push(`  k_cr  = ${(bCr * 1e6 * 100).toFixed(3)} pts/Mtok`);
    lines.push(bIn > 0 && bCr > 0 ? `  → cache-read costs ${(bCr / bIn).toFixed(2)}× fresh input (the #2-vs-#3 contradiction, measured)` : `  → cache/input ratio not quotable (sign unstable at this n)`);
    lines.push(`  intercept ${(freeFit.beta[0] * 100).toFixed(2)}pts/pair ≈ peer share + drift`);
  } else {
    lines.push(`free weights: insufficient rows (<5 steady pairs) — rerun as rows accumulate`);
  }
  for (const h of hyps) {
    if (!h) continue;
    lines.push(`hypothesis cache=${h.crMult}×input: R²=${h.r2 === null ? "n/a" : h.r2.toFixed(3)} → CAP ${fmtCap(h.impliedCap)}`);
  }
  lines.push(`caveats: q_pct integer-grained (±0.5pt/row); peer machine's burn rides the intercept only while roughly constant; cc=0 on this backend (dropped).`);
  return lines.join("\n");
}

export function main(argv) {
  const file = argv[0] ?? path.join(process.cwd(), "botlink-spool", "quota-history.jsonl");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    console.error(`quota-fit: cannot read ${file}`);
    process.exit(1);
  }
  const rows = text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return parseRow(JSON.parse(l));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (rows.length < 2) {
    console.error(`quota-fit: ${rows.length} usable rows — need ≥2`);
    process.exit(1);
  }
  const pairs = pairDeltas(rows);
  const freeFit = fitFreeWeights(pairs);
  const hyps = [fitHypothesis(pairs, 0), fitHypothesis(pairs, 0.1), fitHypothesis(pairs, 0.25)];
  console.log(formatReport(rows, pairs, freeFit, hyps));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
