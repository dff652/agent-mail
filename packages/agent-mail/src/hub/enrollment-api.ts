/** Opt-in provider-to-provider enrollment protocol. Never a browser/MCP proxy. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import {
  EnrollmentError,
  redeemEnrollment,
  recoverEnrollment,
  getEnrollment,
  commitEnrollment,
  cancelEnrollment,
} from "../enrollment.js";
import { RateLimiter } from "./rate-limit.js";

const PREFIX = "/v1/enrollments/";
const MAX_BODY = 4096;
const fields: Record<string, readonly string[]> = {
  redeem: ["code", "request_id", "recovery_proof"],
  recover: ["request_id", "recovery_proof"],
  status: ["enrollment_id", "recovery_proof"],
  commit: ["enrollment_id", "recovery_proof", "commit_id"],
  cancel: ["enrollment_id", "recovery_proof"],
};

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

class WireError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

async function readInput(req: IncomingMessage, action: string): Promise<Record<string, string>> {
  if (req.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
    throw new WireError("json_required", 415);
  }
  const length = req.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY)) {
    throw new WireError("body_too_large", 413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += data.length;
    if (size > MAX_BODY) throw new WireError("body_too_large", 413);
    chunks.push(data);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new WireError("invalid_request", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new WireError("invalid_request", 400);
  }
  const input = value as Record<string, unknown>;
  const required = fields[action]!;
  if (Object.keys(input).length !== required.length || required.some(key => (
    typeof input[key] !== "string" || !input[key] || (input[key] as string).length > 512
  ))) throw new WireError("invalid_request", 400);
  return input as Record<string, string>;
}

export function createEnrollmentListener(home: string, enabled: boolean) {
  // One bounded global key per Hub limits both guessing and persistent-journal churn.
  const requests = new RateLimiter(120, 60_000);
  const redemptions = new RateLimiter(30, 60_000);
  return async (req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> => {
    if (!pathname.startsWith(PREFIX)) return false;
    try {
      const action = pathname.slice(PREFIX.length);
      if (!enabled || !Object.hasOwn(fields, action)) throw new WireError("not_found", 404);
      if (!(req.socket as TLSSocket).encrypted || req.headers.origin !== undefined) {
        throw new WireError("provider_transport_required", 403);
      }
      if (req.method !== "POST") throw new WireError("method_not_allowed", 405);
      if ((req.url || "").includes("?")) throw new WireError("invalid_request", 400);
      try {
        requests.check("hub");
        if (action === "redeem") redemptions.check("hub");
      } catch { throw new WireError("rate_limited", 429); }
      const input = await readInput(req, action);
      let value: unknown;
      switch (action) {
        case "redeem": value = redeemEnrollment(home, {
          code: input.code!, request_id: input.request_id!, recovery_proof: input.recovery_proof!,
        }); break;
        case "recover": value = recoverEnrollment(home, {
          request_id: input.request_id!, recovery_proof: input.recovery_proof!,
        }); break;
        case "status": value = getEnrollment(home, {
          enrollment_id: input.enrollment_id!, recovery_proof: input.recovery_proof!,
        }); break;
        case "commit": value = commitEnrollment(home, {
          enrollment_id: input.enrollment_id!, recovery_proof: input.recovery_proof!, commit_id: input.commit_id!,
        }); break;
        case "cancel": value = cancelEnrollment(home, {
          enrollment_id: input.enrollment_id!, recovery_proof: input.recovery_proof!,
        }); break;
      }
      reply(res, 200, { ok: true, value });
    } catch (error) {
      const known = error instanceof WireError || error instanceof EnrollmentError;
      const code = known ? error.code : "enrollment_unavailable";
      reply(res, known ? error.status : 503, { ok: false, error: { code, message: code } });
    }
    return true;
  };
}
