# agent-reputation-api

[![CI](https://github.com/Retsumdk/agent-reputation-api/actions/workflows/ci.yml/badge.svg)](https://github.com/Retsumdk/agent-reputation-api/actions/workflows/ci.yml)

Time-decayed, sybil-damped reputation scores for autonomous agents. Agents attest about each other on four dimensions; the ledger verifies every attestation's HMAC signature, dampes attestor influence by the attestor's own reputation, decays stale evidence with a 30-day half-life, and reports a score with an honest statistical lower bound — so "4.9 stars from two friends" never reads as trust.

Zero runtime dependencies. TypeScript strict mode. Node ≥ 18.17, Bun, or any runtime with `node:crypto` and WHATWG `fetch`.

## The problem

Multi-agent systems delegate work to each other, but they have no memory of who actually delivered. Every agent starts each negotiation trusting-or-not based on a prompt, and a single loud failure (or a coordinated ring of flatterers) resets the board. What's missing is a small, verifiable ledger that answers one question: *given everything peers have signed about this agent, how much should you trust it right now — and how confident are we, really?*

## How it works

```
attestor ── signs ──▶ Attestation ──▶ ReputationLedger ──▶ ScoreReport
            (HMAC)      (nonce, ts)        (guards)          (per dimension)
```

**Attestations.** A peer attests `{attestorId, subjectId, dimension, score 0–100, ts, nonce}`. The canonical string `v1|attestor|subject|dimension|score|ts|nonce` is signed with HMAC-SHA256 under a network secret; verification is constant-time. Four dimensions: `reliability`, `correctness`, `responsiveness`, `candor`.

**Ledger guards** (each a distinct rejection, not a silent drop):

| Guard | Error | Why |
|---|---|---|
| Self-attestation | `FORBIDDEN` (403) | You cannot vote for yourself. |
| Bad signature | `UNAUTHORIZED` (401) | Only secret-holders write. |
| Reused nonce | `REPLAY` (409) | A signed attestation cannot be re-submitted. |
| Timestamp outside ±10 min | `VALIDATION` (400) | Bounds the replay window. |
| > 5 attestations per attestor–subject pair per 24 h | `RATE_LIMITED` (429) | Flood resistance. |
| Unregistered attestor/subject, bad dimension, score ∉ [0, 100] | `VALIDATION` (400) | Schema integrity. |

**Scoring** (per dimension, then aggregated):

1. **Decay** — each attestation's weight halves every 30 days and dies at 180 days.
2. **Sybil damping** — weight is multiplied by `0.25 + 0.75 × (attestor's own composite / 100)`. Unproven attestors count at 0.25; a ring of ten 0-weight voices cannot outvote one trusted dissenter.
3. **Mean** — decay-weighted average of attestation scores.
4. **Confidence** — Kish effective sample size `n_eff = (Σw)² / Σw²`, then the Wilson 95% lower bound on that mean. The lower bound is what the tier ladder consumes, so small, noisy evidence can never masquerade as trust.
5. **Tier ladder** — calibrated to the bound's behavior at small n: `UNPROVEN` (no data) → `PROVISIONAL` (fewer than ~2 effective voices, or lower bound < 25) → `ESTABLISHED` (lower bound ≥ 25) → `TRUSTED` (n_eff ≥ 8 and lower bound ≥ 55). Dissent holds an agent down: two 90s and one 50 leave a lower bound no better than two voices agreeing.

The `composite` is the unweighted mean of dimension means; the report's `lowerBound`/`effectiveSamples` are the *minimum* across dimensions — the weakest dimension decides, which is the conservative reading an operator wants.

**Persistence.** `saveEnvelope` writes a temp file then `rename`s over the target (atomic); nonces are rebuilt from the attestation log on load, so replay protection survives restarts. Per-pair rate-limit state is not persisted and resets on restart — documented, deliberate trade-off.

## Getting started

```bash
git clone https://github.com/Retsumdk/agent-reputation-api.git
cd agent-reputation-api
bun install        # runs the TypeScript build via "prepare"
bun test           # 58 tests
bun run demo       # deterministic scenario — byte-identical every run
```

Or install straight from GitHub (no registry release required — `prepare` builds `dist/` on install):

```bash
npm install github:Retsumdk/agent-reputation-api
```

## Examples

**The deterministic demo** (`bun run demo`): eight agents attest about each other over six days, the clock advances another seven days so decay is visible, and every score report is rendered:

```
agent scout-1 — ESTABLISHED
composite 91.1  lower-bound 36.5  n-eff 3.0  (computed just now)
  reliability     ██████████████████████·· 91.2  lb 47.4  n-eff 5.0
  correctness     ██████████████████████·· 91.0  lb 36.5  n-eff 3.0
agent scout-2 — PROVISIONAL
composite 51.5  lower-bound 5.1  n-eff 1.0  (computed just now)
  reliability     █████████████··········· 55.0  lb 6.5  n-eff 1.0
  responsiveness  ████████████············ 48.0  lb 5.1  n-eff 1.0
agent summarizer-1 — ESTABLISHED
composite 81.2  lower-bound 26.1  n-eff 2.9  (computed just now)
  reliability     ████████████████████···· 85.0  lb 32.1  n-eff 3.0
  responsiveness  ██████████████████······ 76.5  lb 26.1  n-eff 2.9
  candor          ████████████████████···· 82.0  lb 30.1  n-eff 3.0
agent verifier-1 — ESTABLISHED
composite 91.3  lower-bound 28.1  n-eff 2.0  (computed just now)
  reliability     ██████████████████████·· 90.5  lb 28.2  n-eff 2.0
  correctness     ██████████████████████·· 93.0  lb 29.7  n-eff 2.0
  candor          ██████████████████████·· 90.5  lb 28.1  n-eff 2.0
agent planner-1 — ESTABLISHED
composite 88.0  lower-bound 34.3  n-eff 3.0  (computed just now)
  responsiveness  █████████████████████··· 88.0  lb 34.3  n-eff 3.0
agent executor-1 — ESTABLISHED
composite 86.0  lower-bound 25.6  n-eff 2.0  (computed just now)
  reliability     █████████████████████··· 86.0  lb 25.6  n-eff 2.0
agent auditor-1 — PROVISIONAL
composite 84.0  lower-bound 14.7  n-eff 1.0  (computed just now)
  correctness     ████████████████████···· 84.0  lb 14.7  n-eff 1.0
agent indexer-1 — PROVISIONAL
composite 83.0  lower-bound 14.3  n-eff 1.0  (computed just now)
  reliability     ████████████████████···· 83.0  lb 14.3  n-eff 1.0
network: 8 agents, 32 attestations (0 in the last 24h)
```

Read it like an operator: `scout-1` has six consistent voices on reliability (n-eff 5.0, lower bound 47.4) and is the agent you hand the research task to. `auditor-1` and `indexer-1` have fine averages from a single voice each — one opinion, not a reputation — so they stay PROVISIONAL. `scout-2` is damped twice over: weak scores *and* attestors whose own reputation is unproven.

**Run the HTTP API and attest from the CLI:**

```bash
export REP_SECRET="dev-secret"
rep serve --port 7300 --state ledger.json        # first boot starts fresh
# another shell:
rep attest --url http://127.0.0.1:7300 \
  --attestor planner-1 --subject scout-1 \
  --dimension reliability --score 92
rep score scout-1 --url http://127.0.0.1:7300
```

**As a library:**

```ts
import { ReputationLedger, signAttestation, newNonce } from "agent-reputation-api";

const ledger = new ReputationLedger({ secret: "network-secret" });
ledger.registerAgent("planner-1");
ledger.registerAgent("scout-1");

const input = {
  attestorId: "planner-1", subjectId: "scout-1",
  dimension: "reliability" as const, score: 92,
  ts: Date.now(), nonce: newNonce(), sig: "",
};
input.sig = signAttestation(input, "network-secret");
ledger.submitAttestation(input);

const report = ledger.score("scout-1");
console.log(report.composite, report.tier); // 92 "provisional" (one voice)
```

Expected: the single attestation yields `composite ≈ 92` but tier `provisional` — one voice is never a reputation.

## HTTP API

Writes require `Authorization: Bearer <secret>` (constant-time comparison). All errors are structured JSON: `{"error": {"code", "message"}}`.

| Route | Auth | Purpose |
|---|---|---|
| `GET /health` | — | Liveness + counters. |
| `POST /agents` | ✓ | `{id, displayName?}` → 201 / 409 DUPLICATE. |
| `POST /attestations` | ✓ | Signed attestation → 201 / 401 / 403 / 409 / 429. |
| `POST /sign` | ✓ | Convenience: signs an unsigned attestation with the server secret. |
| `GET /agents` | — | Every agent with its current score report. |
| `GET /agents/:id` | — | Agent record + score report → 404 if unknown. |
| `GET /network/stats` | — | Totals, per-dimension counts, top agents by composite. |

## Project layout

```
src/
  types.ts         domain types, dimension registry
  errors.ts        ReputationError taxonomy + HTTP status map
  clock.ts         injectable clock (system + fixed for tests)
  crypto.ts        canonical string, HMAC sign/verify, constant-time compare
  scoring.ts       decay, attestor damping, Kish n-eff, Wilson bound, tiers
  ledger.ts        the ledger: registration, guards, scoring, stats
  persistence.ts   atomic envelope save/load
  server.ts        zero-dependency Node http control plane
  format.ts        deterministic score-report rendering
  demo.ts          the deterministic 8-agent scenario
  cli.ts           the `rep` CLI (demo / serve / attest / score)
tests/             58 tests across 7 files (bun test)
```

## Limits (by design)

- **Single registry.** Attestations are HMAC-signed under one network secret; this is a per-organization ledger, not a global blockchain. Cross-network federation is out of scope on purpose.
- **One damping pass.** Attestor weights come from a first-pass composite computed with all attestors at the unproven baseline. Fixed-point iteration would be marginally more precise and materially harder to reason about; the damping direction is what matters.
- **Rate-limit state is in-memory.** Restart resets pair counters; nonces do survive restarts via the envelope.
- **Wilson bounds are approximate here.** The bound treats the weighted mean as a binomial proportion with n = n_eff — a deliberate, documented approximation, not a Bayesian estimator.

## Scripts

| Script | What it does |
|---|---|
| `bun run build` | `tsc -p tsconfig.json` → `dist/` |
| `bun test` | Full test suite |
| `bun run typecheck` | Strict typecheck of `src/` + `tests/` |
| `bun run demo` | Build + run the deterministic demo |

## License

MIT — see [LICENSE](LICENSE).
