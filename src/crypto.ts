import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Attestation, AttestationInput } from "./types.js";

/**
 * Canonical string that the signature covers. Field order is fixed; the
 * signature domain is exactly these seven values.
 */
export function canonicalAttestation(att: Attestation | AttestationInput): string {
  return [
    "v1",
    att.attestorId,
    att.subjectId,
    att.dimension,
    String(att.score),
    String(att.ts),
    att.nonce,
  ].join("|");
}

export function signAttestation(att: AttestationInput, secret: string): string {
  return createHmac("sha256", secret).update(canonicalAttestation(att)).digest("hex");
}

export function verifyAttestation(att: AttestationInput, secret: string): boolean {
  const expected = Buffer.from(signAttestation(att, secret), "hex");
  const presented = Buffer.from(att.sig, "hex");
  if (expected.length !== presented.length) return false;
  return timingSafeEqual(expected, presented);
}

export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = Buffer.from(a, "utf8");
  const bBytes = Buffer.from(b, "utf8");
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}
