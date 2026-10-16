import { describe, test, expect, beforeEach } from "bun:test";
import { ReputationLedger, DEFAULTS } from "../src/ledger.js";
import { ReputationError } from "../src/errors.js";
import { fixedClock } from "../src/clock.js";
import { signAttestation, newNonce } from "../src/crypto.js";
import type { AttestationInput } from "../src/types.js";

const SECRET = "ledger-secret";
const START = Date.UTC(2026, 6, 1);
const DAY = 86_400_000;

function makeLedger(overrides: Partial<Parameters<typeof ReputationLedger.prototype.submitAttestation>> = {}) {
  void overrides;
  return new ReputationLedger({ secret: SECRET, clock: fixedClock(START) });
}

function signed(ledger: ReputationLedger, input: Partial<AttestationInput>): AttestationInput {
  const full: AttestationInput = {
    attestorId: "planner-1",
    subjectId: "scout-1",
    dimension: "reliability",
    score: 90,
    ts: START,
    nonce: newNonce(),
    sig: "",
    ...input,
  };
  full.sig = signAttestation(full, SECRET);
  return full;
}

function seed(ledger: ReputationLedger): void {
  ledger.registerAgent("planner-1", "Planner");
  ledger.registerAgent("scout-1", "Scout");
}

describe("registerAgent", () => {
  test("registers with trimmed id and optional display name", () => {
    const ledger = makeLedger();
    const record = ledger.registerAgent(" scout-1 ", "Scout");
    expect(record.id).toBe("scout-1");
    expect(record.displayName).toBe("Scout");
    expect(record.attestationCount).toBe(0);
  });

  test("rejects duplicate ids", () => {
    const ledger = makeLedger();
    ledger.registerAgent("scout-1");
    expect(() => ledger.registerAgent("scout-1")).toThrow(ReputationError);
    try {
      ledger.registerAgent("scout-1");
    } catch (err) {
      expect((err as ReputationError).code).toBe("DUPLICATE");
    }
  });

  test("rejects invalid ids", () => {
    const ledger = makeLedger();
    for (const bad of ["", "a", "has space", "ok/no", "x".repeat(65)]) {
      expect(() => ledger.registerAgent(bad)).toThrow(ReputationError);
    }
  });
});

describe("submitAttestation", () => {
  test("accepts a valid signed attestation and updates the subject", () => {
    const ledger = makeLedger();
    seed(ledger);
    const att = ledger.submitAttestation(signed(ledger, {}));
    expect(att.subjectId).toBe("scout-1");
    expect(ledger.getAgent("scout-1").attestationCount).toBe(1);
    expect(ledger.attestationCount()).toBe(1);
  });

  test("rejects an unsigned or badly signed attestation when a secret is set", () => {
    const ledger = makeLedger();
    seed(ledger);
    const unsigned = signed(ledger, {});
    unsigned.sig = "";
    expect(() => ledger.submitAttestation(unsigned)).toThrow(/signature/);
    const forged = signed(ledger, {});
    forged.sig = signAttestation({ ...forged, score: 1 }, SECRET);
    expect(() => ledger.submitAttestation(forged)).toThrow(ReputationError);
    const e = (() => {
      try {
        ledger.submitAttestation(forged);
      } catch (err) {
        return err as ReputationError;
      }
      throw new Error("unreachable");
    })();
    expect(e.code).toBe("UNAUTHORIZED");
  });

  test("rejects self-attestation with FORBIDDEN", () => {
    const ledger = makeLedger();
    seed(ledger);
    const att = signed(ledger, { attestorId: "scout-1", subjectId: "scout-1" });
    expect(() => ledger.submitAttestation(att)).toThrow(/self-attestation/);
  });

  test("rejects unknown attestor and unknown subject", () => {
    const ledger = makeLedger();
    seed(ledger);
    expect(() => ledger.submitAttestation(signed(ledger, { attestorId: "ghost" }))).toThrow(/attestor not registered/);
    expect(() => ledger.submitAttestation(signed(ledger, { subjectId: "ghost" }))).toThrow(/subject not registered/);
  });

  test("rejects invalid dimension, score, ts, nonce", () => {
    const ledger = makeLedger();
    seed(ledger);
    expect(() => ledger.submitAttestation(signed(ledger, { dimension: "charm" as never }))).toThrow(/dimension/);
    expect(() => ledger.submitAttestation(signed(ledger, { score: 101 }))).toThrow(/score/);
    expect(() => ledger.submitAttestation(signed(ledger, { score: -1 }))).toThrow(/score/);
    expect(() => ledger.submitAttestation(signed(ledger, { score: Number.NaN }))).toThrow(/score/);
    expect(() => ledger.submitAttestation(signed(ledger, { ts: 1.5 }))).toThrow(/ts/);
    expect(() => ledger.submitAttestation(signed(ledger, { nonce: "short" }))).toThrow(/nonce/);
  });

  test("rejects timestamps outside the skew window", () => {
    const ledger = makeLedger();
    seed(ledger);
    expect(() => ledger.submitAttestation(signed(ledger, { ts: START - DEFAULTS.timestampSkewMs - 1 }))).toThrow(/skew/);
    expect(() => ledger.submitAttestation(signed(ledger, { ts: START + DEFAULTS.timestampSkewMs + 1 }))).toThrow(/skew/);
  });

  test("replays are rejected by nonce", () => {
    const ledger = makeLedger();
    seed(ledger);
    const att = signed(ledger, { nonce: "fixed-nonce-1" });
    ledger.submitAttestation(att);
    expect(() => ledger.submitAttestation({ ...att })).toThrow(ReputationError);
    try {
      ledger.submitAttestation({ ...att });
    } catch (err) {
      expect((err as ReputationError).code).toBe("REPLAY");
    }
  });

  test("rate limit caps attestations per attestor-subject pair in the window", () => {
    const clock = fixedClock(START);
    const ledger = new ReputationLedger({ secret: SECRET, clock, rateLimitPerPair: 2 });
    seed(ledger);
    ledger.submitAttestation(signed(ledger, { score: 10 }));
    ledger.submitAttestation(signed(ledger, { score: 20 }));
    expect(() => ledger.submitAttestation(signed(ledger, { score: 30 }))).toThrow(ReputationError);
    try {
      ledger.submitAttestation(signed(ledger, { score: 30 }));
    } catch (err) {
      expect((err as ReputationError).code).toBe("RATE_LIMITED");
    }
    // a different pair is unaffected
    ledger.registerAgent("verifier-1");
    ledger.submitAttestation(signed(ledger, { attestorId: "verifier-1", score: 40 }));
    // and the window slides: a day later the pair is allowed again
    clock.advance(DAY + 1);
    ledger.submitAttestation(signed(ledger, { score: 50, ts: START + DAY + 1 }));
    expect(ledger.attestationCount()).toBe(4);
  });
});

describe("scores", () => {
  test("score() requires a registered agent", () => {
    const ledger = makeLedger();
    expect(() => ledger.score("ghost")).toThrow(ReputationError);
  });

  test("unproven agent scores zero with no attestations", () => {
    const ledger = makeLedger();
    seed(ledger);
    const report = ledger.score("scout-1");
    expect(report.tier).toBe("unproven");
    expect(report.composite).toBe(0);
  });

  test("a well-attested agent earns a high composite", () => {
    const ledger = makeLedger();
    seed(ledger);
    ledger.registerAgent("agent-a");
    ledger.registerAgent("agent-b");
    ledger.submitAttestation(signed(ledger, { attestorId: "agent-a", score: 95 }));
    ledger.submitAttestation(signed(ledger, { attestorId: "agent-b", dimension: "correctness", score: 92 }));
    const report = ledger.score("scout-1");
    expect(report.composite).toBeGreaterThan(90);
    expect(report.dimensions).toHaveLength(2);
  });

  test("allScores covers every agent; networkStats is consistent", () => {
    const ledger = makeLedger();
    seed(ledger);
    ledger.registerAgent("agent-a");
    ledger.submitAttestation(signed(ledger, { attestorId: "agent-a", score: 80 }));
    const scores = ledger.allScores();
    expect(scores).toHaveLength(3);
    const stats = ledger.networkStats();
    expect(stats.agents).toBe(3);
    expect(stats.attestations).toBe(1);
    expect(stats.dimensions.reliability).toBe(1);
    expect(stats.topAgents[0]!.id).toBe("scout-1");
  });
});

describe("envelopes", () => {
  test("round-trips agents and attestations, preserving replay protection", () => {
    const ledger = makeLedger();
    seed(ledger);
    const att = signed(ledger, { nonce: "persisted-nonce" });
    ledger.submitAttestation(att);
    const envelope = ledger.toEnvelope();
    const restored = ReputationLedger.fromEnvelope(envelope, { secret: SECRET, clock: fixedClock(START) });
    expect(restored.getAgent("scout-1").attestationCount).toBe(1);
    expect(restored.attestationCount()).toBe(1);
    expect(() => restored.submitAttestation({ ...att, score: 1 })).toThrow(ReputationError);
  });
});
