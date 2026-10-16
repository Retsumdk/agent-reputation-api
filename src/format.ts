import type { ScoreReport } from "./types.js";

const BAR_WIDTH = 24;

function bar(value: number): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((value / 100) * BAR_WIDTH)));
  return "█".repeat(filled) + "·".repeat(BAR_WIDTH - filled);
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

/**
 * Renders a score report as a deterministic multi-line block. Purely a
 * formatting concern — no math, no I/O.
 */
export function formatScoreReport(report: ScoreReport, now: number): string {
  const age = Math.max(0, now - report.computedAt);
  const fresh = age < 60_000 ? "just now" : age < 3_600_000 ? `${Math.floor(age / 60_000)}m ago` : `${Math.floor(age / 3_600_000)}h ago`;
  const lines: string[] = [];
  lines.push(`agent ${report.agentId} — ${report.tier.toUpperCase()}`);
  lines.push(`composite ${report.composite.toFixed(1)}  lower-bound ${report.lowerBound.toFixed(1)}  n-eff ${report.effectiveSamples.toFixed(1)}  (computed ${fresh})`);
  if (report.dimensions.length === 0) {
    lines.push("  no attestations on record");
  }
  for (const dim of report.dimensions) {
    lines.push(
      `  ${pad(dim.dimension, 15)} ${bar(dim.mean)} ${dim.mean.toFixed(1)}  ` +
        `lb ${dim.lowerBound.toFixed(1)}  n-eff ${dim.effectiveSamples.toFixed(1)}`,
    );
  }
  return lines.join("\n");
}
