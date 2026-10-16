import { rename, writeFile, readFile } from "node:fs/promises";
import type { LedgerEnvelope } from "./types.js";
import { ReputationError } from "./errors.js";

const ENVELOPE_VERSION = 1;

function serialize(envelope: LedgerEnvelope): string {
  return JSON.stringify({ ...envelope, version: ENVELOPE_VERSION }, null, 2) + "\n";
}

/** Atomically persists the envelope: write to a temp file, then rename over the target. */
export async function saveEnvelope(path: string, envelope: LedgerEnvelope): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, serialize(envelope), "utf8");
  await rename(tmp, path);
}

/**
 * Loads an envelope written by saveEnvelope. Throws NOT_FOUND when the file
 * is missing and CORRUPTION when it is not a valid version-1 envelope.
 */
export async function loadEnvelope(path: string): Promise<LedgerEnvelope> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ReputationError("NOT_FOUND", `no state file at ${path}`);
    }
    throw new ReputationError("CORRUPTION", `cannot read ${path}: ${String(err)}`);
  }
  try {
    const parsed = JSON.parse(raw) as LedgerEnvelope;
    if (parsed.version !== ENVELOPE_VERSION || !Array.isArray(parsed.agents) || !Array.isArray(parsed.attestations)) {
      throw new Error("envelope shape mismatch");
    }
    return parsed;
  } catch (err) {
    throw new ReputationError("CORRUPTION", `state file at ${path} is corrupt: ${err instanceof Error ? err.message : String(err)}`);
  }
}

