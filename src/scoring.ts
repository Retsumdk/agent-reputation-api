import type { Attestation, DimensionScore, ReputationTier, ScoreReport } from "./types.js";
import { DIMENSIONS } from "./types.js";
import type { Clock } from "./clock.js";

/** Attestations older than this stop influencing the mean entirely. */
export const MAX_AGE_DAYS = 180;
/** Default half-life: an attestation's weight halves every 30 days. */
export const HALF_LIFE_DAYS = 30;
const Z = 1.96;
const MAX_SCORE = 100;

function decay(att: Attestation, now: number): number {
  const ageDays = (now - att.ts) / 86_400_000;
  if (ageDays > MAX_AGE_DAYS) return 0;
  if (ageDays < 0) return 1;
  return Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
}

/** Attestor trust weight: new/unproven attestors count at 0.25, fully trusted at 1.0. */
export function attestorWeight(attestorComposite: number | undefined): number {
  if (attestorComposite === undefined) return 0.25;
  return 0.25 + 0.75 * (attestorComposite / MAX_SCORE);
}

export function wilsonLowerBound(score: number, n: number): number {
  if (n <= 0) return 0;
  const p = Math.min(Math.max(score / MAX_SCORE, 0), 1);
  const z2 = Z * Z;
  const center = p + z2 / (2 * n);
  const margin = Z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  const lower = (center - margin) / (1 + z2 / n);
  return Math.min(Math.max(lower, 0), 1) * MAX_SCORE;
}

/**
 * Tier thresholds are calibrated against the Wilson lower bound's behavior at
 * small sample sizes: two or three consistent high attestations (n-eff ~2,
 * lower bound ~28+) reach ESTABLISHED, while roughly eight consistent high
 * attestations (n-eff ~8, lower bound ~55+) reach TRUSTED. Dissent or low
 * scores hold an agent at PROVISIONAL.
 *
 * The PROVISIONAL cutoff is 1.5, not 2: Kish effective sample size is always
 * strictly below the raw attestation count when weights differ, so two
 * equal-voice attestors land at n-eff just under 2.0 and must still count as
 * two independent voices.
 */
function tierFor(hasData: boolean, nEff: number, lowerBound: number): ReputationTier {
  if (!hasData || nEff <= 0) return "unproven";
  if (nEff < 1.5) return "provisional";
  if (nEff >= 8 && lowerBound >= 55) return "trusted";
  if (lowerBound >= 25) return "established";
  return "provisional";
}

/**
 * Computes decayed, sybil-damped reputation scores for one agent.
 *
 * `attestorComposites` maps an attestor id to that attestor's own composite
 * score, used to damp self-reinforcing sybil rings. Pass the result of a
 * previous pass (or an empty map for a first estimate).
 */
export function computeScore(
  agentId: string,
  attestations: readonly Attestation[],
  attestorComposites: ReadonlyMap<string, number>,
  clock: Clock,
): ScoreReport {
  const now = clock.now();
  const dimensions: DimensionScore[] = [];

  for (const dimension of DIMENSIONS) {
    let weightSum = 0;
    let squaredSum = 0;
    let weightedScore = 0;
    let count = 0;

    for (const att of attestations) {
      if (att.dimension !== dimension) continue;
      const w = decay(att, now) * attestorWeight(attestorComposites.get(att.attestorId));
      if (w <= 0) continue;
      weightSum += w;
      squaredSum += w * w;
      weightedScore += w * att.score;
      count += 1;
    }

    if (weightSum <= 0) continue;
    const mean = weightedScore / weightSum;
    const nEff = (weightSum * weightSum) / squaredSum;
    dimensions.push({
      dimension,
      mean,
      weight: weightSum,
      effectiveSamples: nEff,
      lowerBound: wilsonLowerBound(mean, nEff),
      count,
    });
  }

  if (dimensions.length === 0) {
    return {
      agentId,
      dimensions: [],
      composite: 0,
      lowerBound: 0,
      effectiveSamples: 0,
      tier: "unproven",
      computedAt: now,
    };
  }

  const composite = dimensions.reduce((sum, d) => sum + d.mean, 0) / dimensions.length;
  const lowerBound = Math.min(...dimensions.map((d) => d.lowerBound));
  const effectiveSamples = Math.min(...dimensions.map((d) => d.effectiveSamples));

  return {
    agentId,
    dimensions,
    composite,
    lowerBound,
    effectiveSamples,
    tier: tierFor(true, effectiveSamples, lowerBound),
    computedAt: now,
  };
}

/** One pass of composite scoring for every agent, used to source attestor weights. */
export function computeAllComposites(
  agents: ReadonlyMap<string, { id: string }>,
  attestations: readonly Attestation[],
  clock: Clock,
): Map<string, number> {
  const bySubject = new Map<string, Attestation[]>();
  for (const att of attestations) {
    const list = bySubject.get(att.subjectId);
    if (list) list.push(att);
    else bySubject.set(att.subjectId, [att]);
  }
  const composites = new Map<string, number>();
  for (const id of agents.keys()) {
    const atts = bySubject.get(id) ?? [];
    composites.set(id, computeScore(id, atts, new Map(), clock).composite);
  }
  return composites;
}
