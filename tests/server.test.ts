import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { ReputationLedger } from "../src/ledger.js";
import { startServer, type ServerOptions } from "../src/server.js";
import { fixedClock } from "../src/clock.js";
import { signAttestation } from "../src/crypto.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const SECRET = "server-secret";
const START = Date.UTC(2026, 6, 1);
let server: Server;
let base: string;

async function request(
  method: string,
  path: string,
  body?: unknown,
  auth = true,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: `Bearer ${SECRET}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text.length > 0 ? JSON.parse(text) : undefined };
}

beforeAll(async () => {
  const ledger = new ReputationLedger({ secret: SECRET, clock: fixedClock(START) });
  server = await startServer({ ledger, secret: SECRET, port: 0 } satisfies ServerOptions);
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => {
  server.close();
});

function signed(body: Record<string, unknown>): Record<string, unknown> {
  return { ...body, sig: signAttestation(body as never, SECRET) };
}

describe("HTTP API", () => {
  test("health is public", async () => {
    const { status, json } = await request("GET", "/health");
    expect(status).toBe(200);
    expect(json.status).toBe("ok");
  });

  test("writes require a bearer token", async () => {
    const { status, json } = await request("POST", "/agents", { id: "a1" }, false);
    expect(status).toBe(401);
    expect(json.error.code).toBe("UNAUTHORIZED");
    const bad = await request("POST", "/agents", { id: "a1" }, false);
    expect(bad.status).toBe(401);
    void bad;
    const wrong = await fetch(`${base}/agents`, {
      method: "POST",
      headers: { authorization: "Bearer wrong-secret", "content-type": "application/json" },
      body: JSON.stringify({ id: "a1" }),
    });
    expect(wrong.status).toBe(401);
  });

  test("register + attest + score round-trip", async () => {
    const reg = await request("POST", "/agents", { id: "scout-1", displayName: "Scout" });
    expect(reg.status).toBe(201);
    expect(reg.json.id).toBe("scout-1");

    const dup = await request("POST", "/agents", { id: "scout-1" });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("DUPLICATE");

    const attestor = await request("POST", "/agents", { id: "planner-1" });
    expect(attestor.status).toBe(201);

    const body = { attestorId: "planner-1", subjectId: "scout-1", dimension: "reliability", score: 90, ts: START, nonce: "srv-nonce-1", sig: "" };
    const unsigned = await request("POST", "/attestations", body);
    expect(unsigned.status).toBe(401);

    const good = await request("POST", "/attestations", signed(body));
    expect(good.status).toBe(201);
    expect(good.json.accepted).toBe(true);

    const replay = await request("POST", "/attestations", signed(body));
    expect(replay.status).toBe(409);
    expect(replay.json.error.code).toBe("REPLAY");

    const score = await request("GET", "/agents/scout-1", undefined, false);
    expect(score.status).toBe(200);
    expect(score.json.agent.id).toBe("scout-1");
    expect(score.json.score.dimensions).toHaveLength(1);
    expect(score.json.score.dimensions[0].mean).toBeCloseTo(90);
  });

  test("missing agent returns 404", async () => {
    const { status, json } = await request("GET", "/agents/ghost", undefined, false);
    expect(status).toBe(404);
    expect(json.error.code).toBe("NOT_FOUND");
  });

  test("self-attestation over HTTP is FORBIDDEN (403)", async () => {
    await request("POST", "/agents", { id: "solo-1" });
    const body = { attestorId: "solo-1", subjectId: "solo-1", dimension: "reliability", score: 99, ts: START, nonce: "srv-nonce-self", sig: "" };
    const res = await request("POST", "/attestations", signed(body));
    expect(res.status).toBe(403);
  });

  test("/sign signs with the server secret and the result is accepted", async () => {
    await request("POST", "/agents", { id: "sign-subject" });
    await request("POST", "/agents", { id: "sign-attestor" });
    const { status, json } = await request("POST", "/sign", {
      attestorId: "sign-attestor",
      subjectId: "sign-subject",
      dimension: "candor",
      score: 70,
      ts: START,
      nonce: "srv-nonce-sign",
    });
    expect(status).toBe(200);
    expect(json.sig).toMatch(/^[0-9a-f]{64}$/);
    const submit = await request("POST", "/attestations", json);
    expect(submit.status).toBe(201);
  });

  test("malformed JSON is a 400 VALIDATION, not a 500", async () => {
    const res = await fetch(`${base}/agents`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("VALIDATION");
  });

  test("unknown routes are 404 with the route echoed", async () => {
    const { status, json } = await request("GET", "/nope", undefined, false);
    expect(status).toBe(404);
    expect(json.error.message).toContain("/nope");
  });

  test("network stats aggregate the ledger", async () => {
    const { status, json } = await request("GET", "/network/stats", undefined, false);
    expect(status).toBe(200);
    expect(json.agents).toBeGreaterThanOrEqual(4);
    expect(json.attestations).toBeGreaterThanOrEqual(2);
  });
});
