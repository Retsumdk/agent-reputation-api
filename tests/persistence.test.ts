import { describe, test, expect, afterAll } from "bun:test";
import { saveEnvelope, loadEnvelope } from "../src/persistence.js";
import { ReputationError } from "../src/errors.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "rep-test-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("persistence", () => {
  test("round-trips an envelope", async () => {
    const path = join(dir, "state.json");
    const envelope = {
      version: 1 as const,
      savedAt: 1234,
      agents: [{ id: "a1", createdAt: 1, attestationCount: 0, lastActivityAt: 1 }],
      attestations: [],
    };
    await saveEnvelope(path, envelope);
    const loaded = await loadEnvelope(path);
    expect(loaded).toEqual(envelope);
  });

  test("missing file throws NOT_FOUND", async () => {
    try {
      await loadEnvelope(join(dir, "missing.json"));
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReputationError).code).toBe("NOT_FOUND");
    }
  });

  test("corrupt file throws CORRUPTION", async () => {
    const path = join(dir, "corrupt.json");
    writeFileSync(path, "{ not json");
    try {
      await loadEnvelope(path);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReputationError).code).toBe("CORRUPTION");
    }
  });

  test("wrong version throws CORRUPTION", async () => {
    const path = join(dir, "wrong-version.json");
    writeFileSync(path, JSON.stringify({ version: 99, agents: [], attestations: [] }));
    try {
      await loadEnvelope(path);
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ReputationError).code).toBe("CORRUPTION");
    }
  });
});
