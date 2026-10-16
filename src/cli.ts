#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { ReputationLedger } from "./ledger.js";
import { ReputationError } from "./errors.js";
import { startServer } from "./server.js";
import { loadEnvelope, saveEnvelope } from "./persistence.js";
import { signAttestation, newNonce } from "./crypto.js";
import { formatScoreReport } from "./format.js";
import { DIMENSIONS, type AttestationInput, type Dimension } from "./types.js";
import { runDemo } from "./demo.js";

const USAGE = `rep — reputation ledger for autonomous agents

Usage:
  rep demo
      Run the built-in deterministic scenario locally.
  rep serve [--port N] [--host H] [--state FILE] [--secret S]
      Start the HTTP API. Secret defaults to $REP_SECRET.
  rep attest --url URL --attestor ID --subject ID --dimension D --score N
             [--secret S] [--ts EPOCH_MS] [--nonce N]
      Sign an attestation and submit it to a running server.
      Secret defaults to $REP_SECRET.
  rep score AGENT_ID --url URL
      Fetch and render the score report for an agent.

Dimensions: ${DIMENSIONS.join(", ")}
`;

interface ParsedArgs {
  positional: string[];
  flags: Map<string, string>;
  boolean: Set<string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const boolean = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        boolean.add(key);
      } else {
        flags.set(key, next);
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags, boolean };
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) {
    console.error(`missing required flag --${name}`);
    process.exit(2);
  }
  return value;
}

function parseDimension(raw: string): Dimension {
  if (!(DIMENSIONS as readonly string[]).includes(raw)) {
    console.error(`unknown dimension "${raw}" (expected one of: ${DIMENSIONS.join(", ")})`);
    process.exit(2);
  }
  return raw as Dimension;
}

async function postJson(url: string, path: string, secret: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(new URL(path, url), {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await res.json()) as Record<string, unknown>;
  if (!res.ok) {
    const err = payload.error as { message?: string } | undefined;
    console.error(`server returned ${res.status}: ${err?.message ?? res.statusText}`);
    process.exit(1);
  }
  return payload;
}

export async function runCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return;
  }
  const { positional, flags } = parseArgs(rest);

  if (command === "demo") {
    const { reports, summary } = runDemo();
    for (const report of reports) process.stdout.write(report + "\n");
    process.stdout.write(summary + "\n");
    return;
  }

  if (command === "serve") {
    const port = flags.has("port") ? Number(flags.get("port")) : 7300;
    const host = flags.get("host") ?? "127.0.0.1";
    const secret = flags.get("secret") ?? process.env.REP_SECRET;
    if (secret === undefined || secret.length === 0) {
      console.error("no secret: pass --secret or set REP_SECRET");
      process.exit(2);
    }
    const statePath = flags.get("state");
    const ledger = new ReputationLedger({ secret });
    if (statePath !== undefined) {
      try {
        ledger.applyEnvelope(await loadEnvelope(statePath));
      } catch (err) {
        // A missing state file is a normal first boot; anything else is fatal.
        if (!(err instanceof ReputationError && err.code === "NOT_FOUND")) throw err;
      }
    }
    const serverOptions = statePath === undefined
      ? { ledger, secret, port, host }
      : { ledger, secret, port, host, statePath };
    const server = await startServer(serverOptions);
    const addr = server.address();
    const shown = addr !== null && typeof addr === "object" ? `${addr.address}:${addr.port}` : String(port);
    console.error(`rep listening on http://${shown} (state: ${statePath ?? "in-memory"})`);
    const shutdown = (): void => {
      if (statePath !== undefined) saveEnvelope(statePath, ledger.toEnvelope());
      server.close(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  if (command === "attest") {
    const url = requireFlag(flags, "url");
    const secret = flags.get("secret") ?? process.env.REP_SECRET;
    if (secret === undefined || secret.length === 0) {
      console.error("no secret: pass --secret or set REP_SECRET");
      process.exit(2);
    }
    const score = Number(requireFlag(flags, "score"));
    if (!Number.isFinite(score)) {
      console.error("--score must be a number between 0 and 100");
      process.exit(2);
    }
    const input: AttestationInput = {
      attestorId: requireFlag(flags, "attestor"),
      subjectId: requireFlag(flags, "subject"),
      dimension: parseDimension(requireFlag(flags, "dimension")),
      score,
      ts: flags.has("ts") ? Number(flags.get("ts")) : Date.now(),
      nonce: flags.get("nonce") ?? newNonce(),
      sig: "",
    };
    input.sig = signAttestation(input, secret);
    await postJson(url, "/attestations", secret, input);
    console.log(`attestation accepted: ${input.attestorId} -> ${input.subjectId} (${input.dimension} ${input.score})`);
    return;
  }

  if (command === "score") {
    const agentId = positional[0];
    if (agentId === undefined) {
      console.error("usage: rep score AGENT_ID --url URL");
      process.exit(2);
    }
    const url = requireFlag(flags, "url");
    const res = await fetch(new URL(`/agents/${encodeURIComponent(agentId)}`, url));
    if (!res.ok) {
      console.error(`server returned ${res.status}`);
      process.exit(1);
    }
    const payload = (await res.json()) as { score: Parameters<typeof formatScoreReport>[0] };
    process.stdout.write(formatScoreReport(payload.score, payload.score.computedAt) + "\n");
    return;
  }

  console.error(`unknown command "${command}"`);
  process.stdout.write(USAGE);
  process.exit(2);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
