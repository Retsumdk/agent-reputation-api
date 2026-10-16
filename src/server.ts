import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { saveEnvelope } from "./persistence.js";
import type { ReputationLedger } from "./ledger.js";
import { isReputationError, ReputationError } from "./errors.js";
import { constantTimeEqual, signAttestation, newNonce } from "./crypto.js";

const BODY_LIMIT = 1024 * 1024;

export interface ServerOptions {
  ledger: ReputationLedger;
  secret: string;
  port: number;
  host?: string;
  /** When set, the ledger is atomically persisted to this path after each mutation. */
  statePath?: string;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice(7);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new ReputationError("VALIDATION", "request body exceeds 1 MiB");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ReputationError("VALIDATION", "request body is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ReputationError("VALIDATION", "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function startServer(options: ServerOptions): Promise<Server> {
  const { ledger, secret, port, host, statePath } = options;

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (isReputationError(err)) {
        sendJson(res, err.status, { error: err.toJSON() });
        return;
      }
      const message = err instanceof Error ? err.message : "internal error";
      sendJson(res, 500, { error: { code: "INTERNAL", message } });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const route = `${req.method} ${url.pathname}`;
    const persist = (): void => {
      if (statePath !== undefined) saveEnvelope(statePath, ledger.toEnvelope());
    };

    if (route === "GET /health") {
      sendJson(res, 200, { status: "ok", agents: ledger.listAgents().length, attestations: ledger.attestationCount() });
      return;
    }

    if (route === "GET /network/stats") {
      sendJson(res, 200, ledger.networkStats());
      return;
    }

    const write = req.method === "POST" || req.method === "PUT" || req.method === "DELETE";
    if (write) {
      const token = bearerToken(req);
      if (token === undefined || !constantTimeEqual(token, secret)) {
        sendJson(res, 401, { error: { code: "UNAUTHORIZED", message: "missing or invalid bearer token" } });
        return;
      }
    }

    if (route === "POST /agents") {
      const body = await readJson(req);
      const id = body.id;
      const displayName = body.displayName;
      if (typeof id !== "string") {
        sendJson(res, 400, { error: { code: "VALIDATION", message: "id is required" } });
        return;
      }
      const record = ledger.registerAgent(id, typeof displayName === "string" ? displayName : undefined);
      persist();
      sendJson(res, 201, record);
      return;
    }

    if (route === "POST /attestations") {
      const body = await readJson(req);
      const attestation = ledger.submitAttestation({
        attestorId: String(body.attestorId ?? ""),
        subjectId: String(body.subjectId ?? ""),
        dimension: String(body.dimension ?? ""),
        score: typeof body.score === "number" ? body.score : Number.NaN,
        ts: typeof body.ts === "number" ? body.ts : Date.now(),
        nonce: typeof body.nonce === "string" && body.nonce.length > 0 ? body.nonce : newNonce(),
        sig: String(body.sig ?? ""),
      });
      persist();
      sendJson(res, 201, { accepted: true, attestation });
      return;
    }

    const agentMatch = /^\/agents\/([^/]+)\/?$/.exec(url.pathname);
    if (agentMatch && req.method === "GET") {
      const id = decodeURIComponent(agentMatch[1] as string);
      sendJson(res, 200, { agent: ledger.getAgent(id), score: ledger.score(id) });
      return;
    }

    if (route === "GET /agents") {
      const scores = new Map(ledger.allScores().map((s) => [s.agentId, s]));
      const agents = ledger.listAgents().map((agent) => ({
        agent,
        score: scores.get(agent.id),
      }));
      sendJson(res, 200, { agents });
      return;
    }

    if (route === "POST /sign" ) {
      // Convenience endpoint: signs an unsigned attestation with the server secret.
      const body = await readJson(req);
      const ts = typeof body.ts === "number" ? body.ts : Date.now();
      const input = {
        attestorId: String(body.attestorId ?? ""),
        subjectId: String(body.subjectId ?? ""),
        dimension: String(body.dimension ?? ""),
        score: typeof body.score === "number" ? body.score : Number.NaN,
        ts,
        nonce: typeof body.nonce === "string" && body.nonce.length > 0 ? body.nonce : newNonce(),
        sig: "",
      };
      input.sig = signAttestation(input, secret);
      sendJson(res, 200, input);
      return;
    }

    sendJson(res, 404, { error: { code: "NOT_FOUND", message: `no route: ${route}` } });
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}
