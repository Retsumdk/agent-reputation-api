import { describe, test, expect } from "bun:test";
import { attestorWeight, wilsonLowerBound, computeScore, computeAllComposites, HALF_LIFE_DAYS, MAX_AGE_DAYS } from "../src/scoring.js";
import { fixedClock } from "../src/clock.js";
import type { Attestation } from "../src/types.js";

const DAY = 86_400_000;
const START = Date.UTC(2026, 6, 1);

function att(partial: Partial<Attestation>): Attestation {
  return {
    attestorId: "a1",
    subjectId: "s1",
    dimension: "reliability",
    score: 80,
    ts: START,
    nonce: "n1",
    sig: "sig",
    ...partial,
  };
}

describe("wilsonLowerBound", () => {
  test("0 at zero samples", () => {
    expect(wilsonLowerBound(100, 0)).toBe(0);
  });

  test("a single 100 score has a wide margin, not a 100 bound", () => {
    const lb = wilsonLowerBound(100, 1);
    expect(lb).toBeGreaterThan(0);
    expect(lb).toBeLessThan(50);
  });

  test("tightens as samples grow", () => {
    const one = wilsonLowerBound(90, 1);
    const ten = wilsonLowerBound(90, 10);
    const hundred = wilsonLowerBound(90, 100);
    expect(ten).toBeGreaterThan(one);
    expect(hundred).toBeGreaterThan(ten);
  });

  test("never exceeds the observed mean direction", () => {
    expect(wilsonLowerBound(60, 50)).toBeLessThan(60);
  });
});

describe("attestorWeight", () => {
  test("unproven attestors are damped to 0.25", () => {
    expect(attestorWeight(undefined)).toBe(0.25);
    expect(attestorWeight(0)).toBe(0.25);
  });

  test("fully trusted attestors weigh 1.0", () => {
    expect(attestorWeight(100)).toBe(1.0);
  });

  test("interpolates linearly", () => {
    expect(attestorWeight(50)).toBeCloseTo(0.625);
  });
});

describe("decay via computeScore", () => {
  test("fresh attestations dominate stale ones", () => {
    const clock = fixedClock(START + 30 * DAY);
    const old = att({ ts: START, score: 20 });
    const fresh = att({ ts: START + 29 * DAY, score: 100, nonce: "n2" });
    const report = computeScore("s1", [old, fresh], new Map(), clock);
    const dim = report.dimensions[0]!;
    // old attestation is at half-life (weight 0.5), fresh near 1.0
    expect(dim.mean).toBeGreaterThan((20 + 100) / 2);
    expect(dim.mean).toBeLessThan(100);
  });

  test("attestations beyond max age stop contributing entirely", () => {
    const clock = fixedClock(START + (MAX_AGE_DAYS + 1) * DAY);
    const report = computeScore("s1", [att({})], new Map(), clock);
    expect(report.dimensions).toHaveLength(0);
    expect(report.tier).toBe("unproven");
  });

  test("half-life math: one attestation after exactly HALF_LIFE_DAYS has mean unchanged, weight halved", () => {
    const clock = fixedClock(START + HALF_LIFE_DAYS * DAY);
    const solo = computeScore("s1", [att({ score: 70 })], new Map([["a1", 100]]), clock);
    expect(solo.dimensions[0]!.mean).toBeCloseTo(70);
    // attestorWeight(100) = 1.0, so weight here is pure decay: 0.5 at the half-life
    expect(solo.dimensions[0]!.weight).toBeCloseTo(0.5);
  });
});

describe("computeScore", () => {
  test("high-reputation attestor outweighs a ring of unproven ones", () => {
    const clock = fixedClock(START);
    const trusted = new Map([["reputed", 95]]);
    const ring = [att({ score: 100 }), att({ score: 100, nonce: "n2" }), att({ score: 100, nonce: "n3" })];
    const withTrusted = [att({ attestorId: "reputed", score: 40 }), ...ring];
    const report = computeScore("s1", withTrusted, trusted, clock);
    // 0.25*100*3 vs 0.9625*40 -> trusted dissent keeps the mean well below ring consensus
    expect(report.dimensions[0]!.mean).toBeLessThan(80);
    expect(report.dimensions[0]!.mean).toBeGreaterThan(40);
  });

  test("composite averages dimensions with data only", () => {
    const clock = fixedClock(START);
    const report = computeScore(
      "s1",
      [att({ dimension: "reliability", score: 80 }), att({ dimension: "candor", score: 60, nonce: "n2" })],
      new Map(),
      clock,
    );
    expect(report.composite).toBeCloseTo(70);
    expect(report.dimensions.map((d) => d.dimension).sort()).toEqual(["candor", "reliability"]);
  });

  test("no data -> unproven with zeros", () => {
    const report = computeScore("s1", [], new Map(), fixedClock(START));
    expect(report.tier).toBe("unproven");
    expect(report.composite).toBe(0);
    expect(report.lowerBound).toBe(0);
    expect(report.effectiveSamples).toBe(0);
  });

  test("a single attestation is provisional, not trusted", () => {
    const report = computeScore("s1", [att({ score: 100 })], new Map(), fixedClock(START));
    expect(report.tier).toBe("provisional");
  });

  test("many consistent high attestations reach trusted", () => {
    const clock = fixedClock(START);
    const attestations = Array.from({ length: 12 }, (_, i) =>
      att({ score: 95, nonce: `n${i}`, attestorId: `a${i}` }),
    );
    const report = computeScore("s1", attestations, new Map(), clock);
    expect(report.tier).toBe("trusted");
  });
});

describe("computeAllComposites", () => {
  test("produces a composite per registered agent and zero-weight default pass", () => {
    const clock = fixedClock(START);
    const agents = new Map([
      ["s1", { id: "s1" }],
      ["s2", { id: "s2" }],
    ]);
    const composites = computeAllComposites(agents, [att({ score: 90 })], clock);
    expect(composites.get("s1")).toBeCloseTo(90);
    expect(composites.get("s2")).toBe(0);
  });
});
