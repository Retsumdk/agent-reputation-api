import type { AgentRecord, Attestation, AttestationInput, NetworkStats, ScoreReport } from "./types.js";
import { isDimension } from "./types.js";
import { ReputationError } from "./errors.js";
import { systemClock, type Clock } from "./clock.js";
import { verifyAttestation } from "./crypto.js";
import { computeAllComposites, computeScore } from "./scoring.js";

export interface LedgerOptions {
  clock?: Clock;
  /** When set, every attestation's HMAC signature is verified against it. */
  secret?: string;
  /** Signed timestamp may drift at most this far from ledger time. */
  timestampSkewMs?: number;
  /** Max attestations from one attestor about one subject inside the rate window. */
  rateLimitPerPair?: number;
  rateWindowMs?: number;
  /** Nonce memory bound; oldest nonces are pruned beyond this. */
  nonceCapacity?: number;
}

export const DEFAULTS = {
  timestampSkewMs: 10 * 60 * 1000,
  rateLimitPerPair: 5,
  rateWindowMs: 24 * 60 * 60 * 1000,
  nonceCapacity: 10_000,
} as const;

export class ReputationLedger {
  private readonly agents = new Map<string, AgentRecord>();
  private readonly attestations: Attestation[] = [];
  private readonly nonces = new Map<string, number>();
  private readonly pairTimestamps = new Map<string, number[]>();
  private readonly clock: Clock;
  private readonly secret: string | undefined;
  private readonly skewMs: number;
  private readonly rateLimit: number;
  private readonly rateWindowMs: number;
  private readonly nonceCapacity: number;

  constructor(options: LedgerOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.secret = options.secret;
    this.skewMs = options.timestampSkewMs ?? DEFAULTS.timestampSkewMs;
    this.rateLimit = options.rateLimitPerPair ?? DEFAULTS.rateLimitPerPair;
    this.rateWindowMs = options.rateWindowMs ?? DEFAULTS.rateWindowMs;
    this.nonceCapacity = options.nonceCapacity ?? DEFAULTS.nonceCapacity;
  }

  registerAgent(id: string, displayName?: string): AgentRecord {
    const trimmed = id.trim();
    if (trimmed.length < 2 || trimmed.length > 64 || !/^[\w.:-]+$/.test(trimmed)) {
      throw new ReputationError("VALIDATION", `invalid agent id: "${id}"`);
    }
    if (this.agents.has(trimmed)) {
      throw new ReputationError("DUPLICATE", `agent already registered: ${trimmed}`);
    }
    const now = this.clock.now();
    const record: AgentRecord = {
      id: trimmed,
      createdAt: now,
      attestationCount: 0,
      lastActivityAt: now,
    };
    if (displayName !== undefined) {
      const name = displayName.trim();
      if (name.length < 1 || name.length > 128) {
        throw new ReputationError("VALIDATION", "displayName must be 1-128 characters");
      }
      record.displayName = name;
    }
    this.agents.set(trimmed, record);
    return record;
  }

  hasAgent(id: string): boolean {
    return this.agents.has(id);
  }

  getAgent(id: string): AgentRecord {
    const record = this.agents.get(id);
    if (!record) throw new ReputationError("NOT_FOUND", `agent not registered: ${id}`);
    return record;
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()];
  }

  attestationCount(): number {
    return this.attestations.length;
  }

  submitAttestation(input: AttestationInput): Attestation {
    if (this.secret !== undefined && (typeof input.sig !== "string" || input.sig.length === 0)) {
      throw new ReputationError("UNAUTHORIZED", "attestation signature is required when the ledger verifies signatures");
    }
    const att = this.validate(input);
    if (this.secret !== undefined && !verifyAttestation(att, this.secret)) {
      throw new ReputationError("UNAUTHORIZED", "attestation signature verification failed");
    }
    this.checkReplay(att);
    this.checkRateLimit(att);

    const subject = this.agents.get(att.subjectId) as AgentRecord;
    const now = this.clock.now();
    this.attestations.push(att);
    this.nonces.set(att.nonce, att.ts);
    this.pruneNonces(now);

    subject.attestationCount += 1;
    subject.lastActivityAt = now;
    const attestor = this.agents.get(att.attestorId);
    if (attestor) attestor.lastActivityAt = now;

    return att;
  }

  private validate(input: AttestationInput): Attestation {
    if (typeof input.attestorId !== "string" || typeof input.subjectId !== "string") {
      throw new ReputationError("VALIDATION", "attestorId and subjectId are required strings");
    }
    if (!isDimension(input.dimension)) {
      throw new ReputationError("VALIDATION", `unknown dimension: "${input.dimension}"`);
    }
    if (typeof input.score !== "number" || !Number.isFinite(input.score) || input.score < 0 || input.score > 100) {
      throw new ReputationError("VALIDATION", "score must be a number between 0 and 100");
    }
    if (typeof input.ts !== "number" || !Number.isInteger(input.ts)) {
      throw new ReputationError("VALIDATION", "ts must be an integer epoch-milliseconds value");
    }
    if (typeof input.nonce !== "string" || input.nonce.length < 8 || input.nonce.length > 128) {
      throw new ReputationError("VALIDATION", "nonce must be a string of 8-128 characters");
    }
    if (typeof input.sig !== "string" || input.sig.length === 0) {
      throw new ReputationError("VALIDATION", "sig is required");
    }
    if (input.attestorId === input.subjectId) {
      throw new ReputationError("FORBIDDEN", "self-attestation is rejected");
    }
    if (!this.agents.has(input.attestorId)) {
      throw new ReputationError("VALIDATION", `attestor not registered: ${input.attestorId}`);
    }
    if (!this.agents.has(input.subjectId)) {
      throw new ReputationError("NOT_FOUND", `subject not registered: ${input.subjectId}`);
    }

    const now = this.clock.now();
    if (Math.abs(now - input.ts) > this.skewMs) {
      throw new ReputationError("VALIDATION", "attestation timestamp outside the accepted skew window");
    }

    return {
      attestorId: input.attestorId,
      subjectId: input.subjectId,
      dimension: input.dimension,
      score: input.score,
      ts: input.ts,
      nonce: input.nonce,
      sig: input.sig,
    };
  }

  private checkReplay(att: Attestation): void {
    if (this.nonces.has(att.nonce)) {
      throw new ReputationError("REPLAY", `nonce already used: ${att.nonce}`);
    }
  }

  private checkRateLimit(att: Attestation): void {
    const key = `${att.attestorId}|${att.subjectId}`;
    const timestamps = this.pairTimestamps.get(key) ?? [];
    const now = this.clock.now();
    const recent = timestamps.filter((ts) => now - ts < this.rateWindowMs);
    if (recent.length >= this.rateLimit) {
      throw new ReputationError(
        "RATE_LIMITED",
        `attestor ${att.attestorId} hit the ${this.rateLimit}-per-window cap for subject ${att.subjectId}`,
      );
    }
    recent.push(now);
    this.pairTimestamps.set(key, recent);
  }

  private pruneNonces(now: number): void {
    for (const [nonce, ts] of this.nonces) {
      if (this.nonces.size <= this.nonceCapacity) break;
      if (now - ts > this.skewMs * 2) this.nonces.delete(nonce);
    }
  }

  score(agentId: string): ScoreReport {
    this.getAgent(agentId);
    const composites = computeAllComposites(this.agents, this.attestations, this.clock);
    const subject = this.attestations.filter((att) => att.subjectId === agentId);
    return computeScore(agentId, subject, composites, this.clock);
  }

  allScores(): ScoreReport[] {
    const composites = computeAllComposites(this.agents, this.attestations, this.clock);
    const bySubject = new Map<string, Attestation[]>();
    for (const att of this.attestations) {
      const list = bySubject.get(att.subjectId);
      if (list) list.push(att);
      else bySubject.set(att.subjectId, [att]);
    }
    return [...this.agents.keys()].map((id) =>
      computeScore(id, bySubject.get(id) ?? [], composites, this.clock),
    );
  }

  networkStats(): NetworkStats {
    const now = this.clock.now();
    const dimensions = { reliability: 0, correctness: 0, responsiveness: 0, candor: 0 };
    let last24h = 0;
    for (const att of this.attestations) {
      dimensions[att.dimension] += 1;
      if (now - att.ts < 86_400_000) last24h += 1;
    }
    const topAgents = this.allScores()
      .sort((a, b) => b.composite - a.composite)
      .slice(0, 5)
      .map((s) => ({ id: s.agentId, composite: Math.round(s.composite * 10) / 10, tier: s.tier }));
    return {
      agents: this.agents.size,
      attestations: this.attestations.length,
      attestationsLast24h: last24h,
      dimensions,
      topAgents,
    };
  }

  toEnvelope(): { version: 1; savedAt: number; agents: AgentRecord[]; attestations: Attestation[] } {
    return {
      version: 1,
      savedAt: this.clock.now(),
      agents: this.listAgents(),
      attestations: [...this.attestations],
    };
  }

  /**
   * Restores ledger state from a persistence envelope. Attestations loaded
   * this way are trusted as previously accepted — signatures were verified
   * before the envelope was written.
   */
  applyEnvelope(envelope: { agents: AgentRecord[]; attestations: Attestation[] }): void {
    for (const agent of envelope.agents) {
      this.agents.set(agent.id, { ...agent });
    }
    for (const att of envelope.attestations) {
      this.attestations.push({ ...att });
      this.nonces.set(att.nonce, att.ts);
    }
    this.pruneNonces(this.clock.now());
  }

  static fromEnvelope(envelope: { agents: AgentRecord[]; attestations: Attestation[] }, options: LedgerOptions = {}): ReputationLedger {
    const ledger = new ReputationLedger(options);
    ledger.applyEnvelope(envelope);
    return ledger;
  }
}
