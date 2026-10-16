# agent-reputation-api

Time-decayed, sybil-damped reputation scores for autonomous agents: signed peer attestations, a zero-dependency HTTP API, atomic persistence, and a CLI.

## The problem

Multi-agent systems need to decide *whom to trust*: which scout's research to act on, which executor's code to deploy, which summarizer's output to forward. Self-reported claims are worthless — every agent says it is reliable. Peer attestations help, but naive averaging breaks in three ways:

1. **Stale evidence.** An agent that was excellent six months ago may not be today. A raw lifetime average never forgets.
2. **Sybil rings.** A group of colluding agents can attest about each other to manufacture trust. Unweighted peer votes make this free.
3. **Small-sample overconfidence.** Two perfect attestations do not make an agent trustworthy — but a plain mean looks identical whether it rests on 2 samples or 200.

`agent-reputation-api` solves all three with one scoring model, ships as a single zero-dependency TypeScript package, and exposes the result over a small HTTP API and a CLI.

## How it works

### Attestations

An **attestation** is a signed peer review: one registered agent (`attestorId`) scores another (`subjectId`) on one of four dimensions — `reliability`, `correctness`, `responsiveness`, `candor` — with a 0–100 score, an epoch-millisecond timestamp, and a single-use nonce. The signature is HMAC-SHA256 over a canonical string:

```
v1|<attestorId>|<subjectId>|<dimension>|<score>|<ts>|<nonce>
```

The field order is fixed, so the signature domain is exactly those seven values. Verification is constant-time; tampering with any covered field (or replaying a used nonce) is rejected.

The ledger enforces, in order: structural validation → self-attestation rejection (`FORBIDDEN`) → signature verification (`UNAUTHORIZED`) → nonce replay check (`REPLAY`) → a per-pair rate cap, default 5 attestations per attestor–subject pair per 24h window (`RATE_LIMITED`). Timestamps must fall within a ±10-minute skew window of ledger time.

### Scoring

Each attestation's influence is a product of three factors:

```
w = decay(att.ts) × attestorWeight(attestor's own composite)
```

- **decay** — exponential half-life: weight halves every 30 days; attestations older than 180 days stop contributing entirely.
- **attestorWeight** — sybil damping: an attestor's weight is `0.25 + 0.75 × (attestor's own composite / 100)`. Unproven attestors count at 0.25; a fully trusted attestor counts at 1.0. A ring of fresh accounts shouting 100s cannot outrank one established peer's dissent.

Per dimension, the score is the weighted mean, and confidence comes from the **Kish effective sample size** — `(Σw)² / Σw²` — which discounts heavily when one attestation dominates the weight. The reported `lowerBound` is the Wilson 95% lower bound on that mean, which stays honest at small sample sizes: two perfect attestations yield a lower bound around 28, not 100.

The **composite** is the unweighted mean of dimension means; the report's `lowerBound`/`effectiveSamples` are the most conservative (minimum) across dimensions.

Tiers are calibrated against the Wilson bound's behavior at small n:

| Tier | Condition (per report: min across dimensions) |
|---|---|
| `unproven` | no live attestations |
| `provisional` | effective samples < 1.5, or lower bound < 25 |
| `established` | lower bound ≥ 25 |
| `trusted` | effective samples ≥ 8 **and** lower bound ≥ 55 |

In practice: two or three consistent high attestations reach ESTABLISHED; roughly eight consistent high attestations reach TRUSTED; dissent or low scores hold an agent at PROVISIONAL.

Attestor weights are sourced in two passes: every agent is first scored as if all attestors were unproven (weight 0.25), then each attestation is re-weighted by its attestor's first-pass composite. This damps self-reinforcing rings without requiring an iterative solver.

## Getting started

Requires Node ≥ 18.17 (or Bun ≥ 1.0) for development. The package has **zero runtime dependencies**.

```bash
git clone https://github.com/Retsumdk/agent-reputation-api.git
cd agent-reputation-api
npm install        # runs `prepare`, which builds dist/
npm test           # 58 tests
```

Install straight from GitHub (no registry publish needed):

```bash
npm install github:Retsumdk/agent-reputation-api
```

Bun users: Bun blocks git-dependency lifecycle scripts by default, so run `bun pm trust agent-reputation-api` after `bun add github:Retsumdk/agent-reputation-api`, or just use npm for the install.

## Quick start: the demo

`rep demo` runs a deterministic 8-agent scenario — five days of attestations across a content pipeline, then the clock advances seven days so decay is visible. Output is byte-identical across runs:

```
$ node dist/cli.js demo
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

`scout-2` scores in the 50s and is held at PROVISIONAL despite having data; `auditor-1` scores 84 but a single attestation is not enough evidence — the lower bound says so.

## Running the server

```bash
export REP_SECRET="a-long-random-network-secret"
rep serve --port 7300 --state ledger.json
```

- Writes (register, attest, sign) require `Authorization: Bearer $REP_SECRET`; reads are public.
- With `--state`, the ledger is atomically persisted (temp file + rename) after every mutation and on shutdown. A missing state file is a normal first boot.
- `POST /sign` is a convenience endpoint that signs an unsigned attestation with the server secret, for clients that delegate signing to the operator.

### API

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | public | liveness + counts |
| POST | `/agents` | bearer | register `{ id, displayName? }` |
| POST | `/attestations` | bearer | submit a signed attestation |
| POST | `/sign` | bearer | sign an attestation server-side |
| GET | `/agents` | public | every agent with its current score report |
| GET | `/agents/:id` | public | one agent + score report (404 if unknown) |
| GET | `/network/stats` | public | counts, per-dimension totals, top 5 by composite |

Errors are structured JSON: `{ "error": { "code": "REPLAY", "message": "..." } }` with codes `VALIDATION` (400), `UNAUTHORIZED` (401), `FORBIDDEN` (403), `NOT_FOUND` (404), `DUPLICATE`/`REPLAY` (409), `RATE_LIMITED` (429), `CORRUPTION`/`INTERNAL` (500).

### End-to-end example

```bash
export REP_SECRET="a-long-random-network-secret"
rep serve --port 7300 &

curl -s -X POST localhost:7300/agents -H "authorization: Bearer $REP_SECRET" \
  -H "content-type: application/json" -d '{"id":"alpha-1","displayName":"Alpha"}'
# {"id":"alpha-1","createdAt":1792181488672,"attestationCount":0,...}

curl -s -X POST localhost:7300/agents -H "authorization: Bearer $REP_SECRET" \
  -H "content-type: application/json" -d '{"id":"beta-1"}'

rep attest --url http://127.0.0.1:7300 --attestor alpha-1 --subject beta-1 \
  --dimension reliability --score 91
# attestation accepted: alpha-1 -> beta-1 (reliability 91)

rep score beta-1 --url http://127.0.0.1:7300
# agent beta-1 — PROVISIONAL
# composite 91.0  lower-bound 17.1  n-eff 1.0  (computed just now)
#   reliability     ██████████████████████·· 91.0  lb 17.1  n-eff 1.0

curl -s -X POST localhost:7300/attestations -H "authorization: Bearer $REP_SECRET" \
  -H "content-type: application/json" -d '{"bad":1}'
# {"error":{"code":"UNAUTHORIZED","message":"attestation signature is required when the ledger verifies signatures"}}
```

## Library use

```ts
import { ReputationLedger, signAttestation, fixedClock, newNonce } from "agent-reputation-api";

const clock = fixedClock(Date.UTC(2026, 6, 1));
const ledger = new ReputationLedger({ secret: "network-secret", clock });

ledger.registerAgent("planner-1", "Planner");
ledger.registerAgent("scout-1", "Scout");

const input = {
  attestorId: "planner-1",
  subjectId: "scout-1",
  dimension: "reliability" as const,
  score: 92,
  ts: clock.now(),
  nonce: newNonce(),
  sig: "",
};
input.sig = signAttestation(input, "network-secret");
ledger.submitAttestation(input);

const report = ledger.score("scout-1");
console.log(report.composite, report.tier); // 92 "provisional" — one attestation is thin evidence
```

The `clock` option makes every time-dependent behavior (skew windows, rate windows, decay) deterministic — tests inject `fixedClock`, production uses `systemClock`.

## Persistence

State is a versioned JSON envelope (`{ version: 1, agents, attestations }`). Nonces and rate-window timestamps are rebuilt from the attestation history on load, so replay protection survives restarts. Corrupt files raise a typed `CORRUPTION` error rather than silently starting empty.

## Project layout

```
src/
  types.ts        public data model (attestations, reports, envelope)
  errors.ts       ReputationError taxonomy + HTTP status map
  clock.ts        system/fixed clocks
  crypto.ts       canonical string, HMAC signing/verification, nonces
  scoring.ts      decay, attestor weighting, Wilson bounds, tiers
  ledger.ts       validation, replay/rate guards, queries
  persistence.ts  atomic envelope save/load
  server.ts       zero-dependency HTTP API
  format.ts       score-report rendering
  demo.ts         deterministic 8-agent scenario
  cli.ts          the `rep` CLI
  index.ts        public entry point
tests/            58 tests across 7 files (bun test)
```

## Limits by design

- **Single-registry trust.** One operator holds the HMAC secret; this is a reputation service for one network, not a decentralized protocol. Cross-network federation is out of scope.
- **Two-pass damping.** Attestor weights come from one first-pass scoring round, not a fixed-point iteration. Deeply layered rings are damped, not fully dissolved.
- **Rate windows are in-memory.** The per-pair rate cap resets on restart; replay protection does not (it is rebuilt from persisted attestations).

## Scripts

| Script | What it does |
|---|---|
| `npm run build` | `tsc` → `dist/` with declarations |
| `npm test` | full suite (bun test) |
| `npm run typecheck` | strict typecheck including tests |
| `npm run demo` | build + run the deterministic demo |

## License

MIT — see [LICENSE](LICENSE).
