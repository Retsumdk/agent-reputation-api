import { describe, test, expect } from "bun:test";
import { canonicalAttestation, signAttestation, verifyAttestation, newNonce, constantTimeEqual } from "../src/crypto.js";
import type { AttestationInput } from "../src/types.js";

const SECRET = "test-secret";
const base: AttestationInput = {
  attestorId: "planner-1",
  subjectId: "scout-1",
  dimension: "reliability",
  score: 90,
  ts: 1_752_000_000_000,
  nonce: "abc12345",
  sig: "",
};

describe("canonicalAttestation", () => {
  test("covers all seven fields in fixed order", () => {
    expect(canonicalAttestation(base)).toBe("v1|planner-1|scout-1|reliability|90|1752000000000|abc12345");
  });

  test("score formatting is exact (no float drift)", () => {
    expect(canonicalAttestation({ ...base, score: 88.5 })).toContain("|88.5|");
  });

  test("absent optional fields cannot split the signature domain", () => {
    const a = canonicalAttestation({ ...base, nonce: "x|y" });
    expect(a).toBe("v1|planner-1|scout-1|reliability|90|1752000000000|x|y");
  });
});

describe("sign/verify", () => {
  test("round-trips", () => {
    const att = { ...base, sig: signAttestation(base, SECRET) };
    expect(verifyAttestation(att, SECRET)).toBe(true);
  });

  test("rejects a tampered score", () => {
    const att = { ...base, sig: signAttestation(base, SECRET), score: 10 };
    expect(verifyAttestation(att, SECRET)).toBe(false);
  });

  test("rejects the wrong secret", () => {
    const att = { ...base, sig: signAttestation(base, SECRET) };
    expect(verifyAttestation(att, "other-secret")).toBe(false);
  });

  test("rejects malformed sig hex without throwing", () => {
    expect(verifyAttestation({ ...base, sig: "zz-not-hex" }, SECRET)).toBe(false);
    expect(verifyAttestation({ ...base, sig: "" }, SECRET)).toBe(false);
  });
});

describe("newNonce", () => {
  test("is 32 hex chars and unique across calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const n = newNonce();
      expect(n).toMatch(/^[0-9a-f]{32}$/);
      expect(seen.has(n)).toBe(false);
      seen.add(n);
    }
  });
});

describe("constantTimeEqual", () => {
  test("matches equal strings and rejects mismatches", () => {
    expect(constantTimeEqual("token-1", "token-1")).toBe(true);
    expect(constantTimeEqual("token-1", "token-2")).toBe(false);
    expect(constantTimeEqual("short", "much-longer-string")).toBe(false);
  });
});
