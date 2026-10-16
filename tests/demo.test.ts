import { describe, test, expect } from "bun:test";
import { runDemo } from "../src/demo.js";

describe("runDemo", () => {
  test("is deterministic across runs", () => {
    const a = runDemo();
    const b = runDemo();
    expect(a.reports).toEqual(b.reports);
    expect(a.summary).toEqual(b.summary);
  });

  test("produces a report per agent and a coherent summary", () => {
    const { reports, summary } = runDemo();
    expect(reports).toHaveLength(8);
    expect(reports[0]).toContain("agent scout-1");
    expect(summary).toMatch(/^network: 8 agents, 32 attestations/);
  });

  test("fresh activity shows as established or trusted, not unproven", () => {
    const { reports } = runDemo();
    expect(reports.join("\n")).toMatch(/ESTABLISHED|TRUSTED/);
    expect(reports.join("\n")).not.toContain("UNPROVEN");
  });
});
