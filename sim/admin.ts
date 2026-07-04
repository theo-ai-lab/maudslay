/**
 * Loopback admin/control plane (127.0.0.1:4381).
 *
 * This is the harness's private door: it resets the sim to a named seed, hands
 * back the db witness as JSON, and answers a health probe so CI can poll for
 * readiness instead of sleeping. It is bound to loopback only and is NEVER
 * exposed to the agent under test — the agent sees only the public UI on 4380.
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse, Server } from "node:http";
import { stateSnapshot } from "./db.ts";
import type { AppState } from "./db.ts";
import { applySeed, isSeed } from "./seed.ts";

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

export function startAdmin(state: AppState, port: number): Promise<Server> {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";

    if (method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        seed: state.seedName,
        anchorDate: state.anchorDate,
      });
      return;
    }

    if (method === "GET" && url.pathname === "/state") {
      sendJson(res, 200, stateSnapshot(state));
      return;
    }

    if (method === "POST" && url.pathname === "/reset") {
      const seed = url.searchParams.get("seed") ?? "default";
      if (!isSeed(seed)) {
        sendJson(res, 400, { ok: false, error: `unknown seed: ${seed}` });
        return;
      }
      try {
        applySeed(state, seed);
        sendJson(res, 200, { ok: true, seed, anchorDate: state.anchorDate });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    sendJson(res, 404, { ok: false, error: "not found" });
  });

  return new Promise<Server>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}
