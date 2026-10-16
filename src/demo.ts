import { ReputationLedger } from "./ledger.js";
import type { AttestationInput, Dimension } from "./types.js";
import { signAttestation, newNonce } from "./crypto.js";
import { formatScoreReport } from "./format.js";
import { fixedClock } from "./clock.js";

export const DEMO_SECRET = "demo-network-secret";
export const DAY_MS = 24 * 60 * 60 * 1000;

const AGENTS: Array<{ id: string; displayName: string }> = [
  { id: "scout-1", displayName: "Scout (web research)" },
  { id: "scout-2", displayName: "Scout (fallback)" },
  { id: "summarizer-1", displayName: "Summarizer" },
  { id: "verifier-1", displayName: "Verifier" },
  { id: "planner-1", displayName: "Planner" },
  { id: "executor-1", displayName: "Executor" },
  { id: "auditor-1", displayName: "Auditor" },
  { id: "indexer-1", displayName: "Indexer" },
];

interface Step {
  day: number;
  attestor: string;
  subject: string;
  dimension: Dimension;
  score: number;
}

const STEPS: Step[] = [
  { day: 0, attestor: "planner-1", subject: "scout-1", dimension: "reliability", score: 92 },
  { day: 0, attestor: "verifier-1", subject: "scout-1", dimension: "reliability", score: 90 },
  { day: 0, attestor: "summarizer-1", subject: "scout-1", dimension: "correctness", score: 91 },
  { day: 1, attestor: "executor-1", subject: "scout-1", dimension: "reliability", score: 93 },
  { day: 1, attestor: "auditor-1", subject: "scout-1", dimension: "reliability", score: 89 },
  { day: 1, attestor: "indexer-1", subject: "scout-1", dimension: "reliability", score: 92 },
  { day: 1, attestor: "planner-1", subject: "scout-1", dimension: "correctness", score: 92 },
  { day: 1, attestor: "verifier-1", subject: "scout-1", dimension: "correctness", score: 90 },
  { day: 1, attestor: "scout-1", subject: "summarizer-1", dimension: "reliability", score: 85 },
  { day: 2, attestor: "planner-1", subject: "summarizer-1", dimension: "candor", score: 80 },
  { day: 2, attestor: "scout-1", subject: "summarizer-1", dimension: "candor", score: 82 },
  { day: 2, attestor: "verifier-1", subject: "summarizer-1", dimension: "candor", score: 84 },
  { day: 2, attestor: "executor-1", subject: "summarizer-1", dimension: "reliability", score: 86 },
  { day: 2, attestor: "planner-1", subject: "summarizer-1", dimension: "reliability", score: 84 },
  { day: 2, attestor: "planner-1", subject: "summarizer-1", dimension: "responsiveness", score: 78 },
  { day: 2, attestor: "scout-2", subject: "summarizer-1", dimension: "responsiveness", score: 75 },
  { day: 3, attestor: "planner-1", subject: "verifier-1", dimension: "correctness", score: 94 },
  { day: 3, attestor: "scout-1", subject: "verifier-1", dimension: "correctness", score: 92 },
  { day: 3, attestor: "summarizer-1", subject: "verifier-1", dimension: "candor", score: 91 },
  { day: 3, attestor: "executor-1", subject: "verifier-1", dimension: "candor", score: 90 },
  { day: 3, attestor: "executor-1", subject: "summarizer-1", dimension: "responsiveness", score: 76 },
  { day: 3, attestor: "indexer-1", subject: "verifier-1", dimension: "reliability", score: 90 },
  { day: 3, attestor: "auditor-1", subject: "verifier-1", dimension: "reliability", score: 91 },
  { day: 4, attestor: "scout-1", subject: "planner-1", dimension: "responsiveness", score: 86 },
  { day: 4, attestor: "verifier-1", subject: "planner-1", dimension: "responsiveness", score: 88 },
  { day: 4, attestor: "executor-1", subject: "planner-1", dimension: "responsiveness", score: 90 },
  { day: 4, attestor: "verifier-1", subject: "executor-1", dimension: "reliability", score: 87 },
  { day: 5, attestor: "summarizer-1", subject: "executor-1", dimension: "reliability", score: 85 },
  { day: 5, attestor: "summarizer-1", subject: "scout-2", dimension: "reliability", score: 55 },
  { day: 5, attestor: "summarizer-1", subject: "scout-2", dimension: "responsiveness", score: 48 },
  { day: 5, attestor: "planner-1", subject: "auditor-1", dimension: "correctness", score: 84 },
  { day: 5, attestor: "scout-1", subject: "indexer-1", dimension: "reliability", score: 83 },
];

/**
 * Runs the deterministic demo scenario: five agents attest about each other
 * over six days, the clock then advances another seven days so time decay is
 * visible, and one score report per agent is rendered. Running it twice
 * produces byte-identical output.
 */
export function runDemo(): { reports: string[]; summary: string } {
  const clock = fixedClock(Date.UTC(2026, 6, 10));
  const ledger = new ReputationLedger({ secret: DEMO_SECRET, clock });
  for (const agent of AGENTS) ledger.registerAgent(agent.id, agent.displayName);

  let currentDay = 0;
  for (const step of STEPS) {
    if (step.day > currentDay) {
      clock.advance((step.day - currentDay) * DAY_MS);
      currentDay = step.day;
    }
    const input: AttestationInput = {
      attestorId: step.attestor,
      subjectId: step.subject,
      dimension: step.dimension,
      score: step.score,
      ts: clock.now(),
      nonce: newNonce(),
      sig: "",
    };
    input.sig = signAttestation(input, DEMO_SECRET);
    ledger.submitAttestation(input);
  }

  clock.advance(7 * DAY_MS);
  const now = clock.now();
  const reports = AGENTS.map((agent) => formatScoreReport(ledger.score(agent.id), now));
  const stats = ledger.networkStats();
  const summary =
    `network: ${stats.agents} agents, ${stats.attestations} attestations ` +
    `(${stats.attestationsLast24h} in the last 24h)`;
  return { reports, summary };
}
