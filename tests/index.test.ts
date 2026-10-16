import { describe, test, expect } from "bun:test";
import * as api from "../src/index.js";

describe("public API surface", () => {
  test("exports the documented entry points", () => {
    for (const name of [
      "ReputationLedger",
      "ReputationError",
      "isReputationError",
      "systemClock",
      "fixedClock",
      "canonicalAttestation",
      "signAttestation",
      "verifyAttestation",
      "newNonce",
      "constantTimeEqual",
      "computeScore",
      "computeAllComposites",
      "attestorWeight",
      "wilsonLowerBound",
      "saveEnvelope",
      "loadEnvelope",
      "startServer",
      "runDemo",
      "runCli",
      "DIMENSIONS",
    ]) {
      expect((api as Record<string, unknown>)[name], `missing export: ${name}`).toBeDefined();
    }
  });
});
