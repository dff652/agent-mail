import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { authenticateBearer } from "../src/hub/auth.js";
import { listenHub } from "../src/hub/server.js";
import {
  createPairing,
  generateCode,
  hashCode,
  listPairings,
  PairingError,
  redeemPairing,
  revokePairing,
} from "../src/pairing.js";
import { loadRoster, rosterHas } from "../src/roster.js";
import * as svc from "../src/services.js";

function tmpHome(): string {
  return svc.initProject(
    path.join(fs.mkdtempSync(path.join(os.tmpdir(), "am-pair-")), ".agent-mail"),
  );
}

describe("L2 pairing enrollment", () => {
  it("generateCode is crockford XXXX-XXXX", () => {
    const c = generateCode();
    expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(hashCode(c)).toHaveLength(64);
  });

  it("create → redeem enrolls roster and mints token once", () => {
    const home = tmpHome();
    const created = createPairing(home, "newbie@local", { label: "Newbie" });
    expect(created.code).toMatch(/-/);
    expect(created.pair_id.startsWith("pair_")).toBe(true);

    const redeemed = redeemPairing(home, created.code);
    expect(redeemed.agent_id).toBe("newbie@local");
    expect(redeemed.token.length).toBeGreaterThan(20);
    expect(rosterHas(loadRoster(home), "newbie@local")).toBe(true);
    expect(authenticateBearer(home, `Bearer ${redeemed.token}`)).toBe(
      "newbie@local",
    );

    // second redeem fails (unified error)
    expect(() => redeemPairing(home, created.code)).toThrow(PairingError);
    expect(() => redeemPairing(home, created.code)).toThrow(
      /invalid_or_expired/,
    );

    const listed = listPairings(home);
    expect(listed.some((r) => r.id === created.pair_id && r.status === "redeemed")).toBe(
      true,
    );
  });

  it("revoke pending code; invalid codes do not enumerate", () => {
    const home = tmpHome();
    const created = createPairing(home, "temp@local");
    expect(revokePairing(home, created.pair_id)).toBe(true);
    expect(() => redeemPairing(home, created.code)).toThrow(
      /invalid_or_expired/,
    );
    expect(() => redeemPairing(home, "ZZZZ-ZZZZ")).toThrow(
      /invalid_or_expired/,
    );
  });

  it("HTTP POST /v1/pair/redeem returns token", async () => {
    const home = tmpHome();
    const created = createPairing(home, "http-agent@local");
    const hub = await listenHub({ home, host: "127.0.0.1", port: 0 });
    try {
      const res = await fetch(`${hub.url}/v1/pair/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: created.code }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        agent_id: string;
        token: string;
        pair_id: string;
      };
      expect(body.agent_id).toBe("http-agent@local");
      expect(body.token).toBeTruthy();
      expect(body.pair_id).toBe(created.pair_id);
    } finally {
      hub.server.close();
    }
  });

  it("pairing.sqlite lives under auth/", () => {
    const home = tmpHome();
    createPairing(home, "x@local");
    expect(fs.existsSync(path.join(home, "auth", "pairing.sqlite"))).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(home, "auth")).mode & 0o777).toBe(0o700);
      expect(
        fs.statSync(path.join(home, "auth", "pairing.sqlite")).mode & 0o777,
      ).toBe(0o600);
    }
  });
});
