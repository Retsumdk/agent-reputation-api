export type Dimension = "reliability" | "correctness" | "responsiveness" | "candor";

export const DIMENSIONS: readonly Dimension[] = [
  "reliability",
  "correctness",
  "responsiveness",
  "candor",
] as const;

export function isDimension(value: string): value is Dimension {
  return (DIMENSIONS as readonly string[]).includes(value);
}

/** A signed peer attestation about one agent on one dimension. */
export interface Attestation {
  attestorId: string;
  subjectId: string;
  dimension: Dimension;
  /** 0-100 */
  score: number;
  /** Epoch milliseconds, asserted by the attestor. */
  ts: number;
  /** Globally unique, single-use identifier. */
  nonce: string;
  /** HMAC-SHA256 hex digest over the canonical attestation string. */
  sig: string;
}

export interface AgentRecord {
  id: string;
  displayName?: string;
  createdAt: number;
  attestationCount: number;
  lastActivityAt: number;
}

export interface DimensionScore {
  dimension: Dimension;
  /** Time-decayed weighted mean, 0-100. */
  mean: number;
  /** Sum of decayed attestation weights behind the mean. */
  weight: number;
  /** Kish effective sample size of the decayed weights. */
  effectiveSamples: number;
  /** Wilson 95% lower bound on the mean, 0-100. */
  lowerBound: number;
  /** Number of raw attestations behind this dimension. */
  count: number;
}

export type ReputationTier = "unproven" | "provisional" | "established" | "trusted";

export interface ScoreReport {
  agentId: string;
  dimensions: DimensionScore[];
  /** Unweighted mean of dimension means; 0 when no data exists. */
  composite: number;
  /** Most conservative (lowest) dimension lower bound; 0 when no data exists. */
  lowerBound: number;
  /** Smallest dimension effective sample size; 0 when no data exists. */
  effectiveSamples: number;
  tier: ReputationTier;
  computedAt: number;
}

export interface NetworkStats {
  agents: number;
  attestations: number;
  attestationsLast24h: number;
  dimensions: Record<Dimension, number>;
  topAgents: Array<{ id: string; composite: number; tier: ReputationTier }>;
}

export interface LedgerEnvelope {
  version: 1;
  savedAt: number;
  agents: AgentRecord[];
  attestations: Attestation[];
}

export interface AttestationInput {
  attestorId: string;
  subjectId: string;
  dimension: string;
  score: number;
  ts: number;
  nonce: string;
  sig: string;
}
