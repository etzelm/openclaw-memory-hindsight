import { describe, expect, it } from "vitest";
import { hindsightConfigSchema } from "./config.js";
import {
  conversationBankId,
  ownerBankId,
  type MemoryAudience,
  routeAudience,
  sessionUsesMemory,
} from "./routing.js";

describe("routeAudience", () => {
  it("maps owner-private to the per-agent bank used by the third-party plugin", () => {
    const audience: MemoryAudience = { kind: "owner-private", agentId: "dev" };
    expect(routeAudience("dev", audience)).toEqual({
      ok: true,
      bankId: "dev",
      audience,
    });
  });

  it("maps a conversation audience to a separate bank keyed by its root session", () => {
    const audience: MemoryAudience = {
      kind: "conversation",
      agentId: "main",
      sessionKey: "agent:main:telegram:group:-100",
      sessionId: "s1",
    };
    const route = routeAudience("main", audience);
    const bankId = route.ok ? route.bankId : "";
    expect(bankId).toBe(conversationBankId("main", "agent:main:telegram:group:-100"));
    expect(bankId).toMatch(/^main::conv::[0-9a-f]{16}$/);
    // Session id rotation (reset) keeps the same conversation bank.
    const reset = routeAudience("main", { ...audience, sessionId: "s2" });
    expect(reset.ok && reset.bankId).toBe(bankId);
    // Another conversation gets another bank.
    const other = routeAudience("main", {
      ...audience,
      sessionKey: "agent:main:x",
    });
    expect(other.ok && other.bankId).not.toBe(bankId);
  });

  it("refuses a missing audience, a missing agent, or another agent's audience", () => {
    expect(routeAudience("dev", undefined)).toMatchObject({ ok: false });
    expect(routeAudience(undefined, { kind: "owner-private", agentId: "dev" })).toMatchObject({
      ok: false,
    });
    expect(routeAudience("dev", { kind: "owner-private", agentId: "main" })).toMatchObject({
      ok: false,
      reason: expect.stringContaining("another agent"),
    });
  });
});

describe("sessionUsesMemory", () => {
  it("skips excluded providers, operational and temp sessions", () => {
    const cfg = hindsightConfigSchema.parse({
      hindsightApiUrl: "http://h",
      allowInsecureHttp: true,
      excludeProviders: ["heartbeat"],
    });
    expect(sessionUsesMemory(cfg, { messageProvider: "heartbeat" })).toBe(false);
    expect(sessionUsesMemory(cfg, { sessionKey: "agent:dev:cron:nightly:run" })).toBe(false);
    expect(sessionUsesMemory(cfg, { sessionKey: "agent:dev:subagent:abc" })).toBe(false);
    expect(sessionUsesMemory(cfg, { sessionKey: "temp:x" })).toBe(false);
    expect(sessionUsesMemory(cfg, { sessionKey: "agent:dev:main" })).toBe(true);
    const ops = hindsightConfigSchema.parse({
      hindsightApiUrl: "http://h",
      allowInsecureHttp: true,
      skipOperationalSessions: false,
    });
    expect(sessionUsesMemory(ops, { sessionKey: "agent:dev:subagent:abc" })).toBe(true);
    expect(sessionUsesMemory(ops, { sessionKey: "temp:x" })).toBe(false);
  });
});

describe("agentBankMap", () => {
  it("maps an agent's owner and conversation banks to the configured bank", () => {
    const map = { "wb-dev": "wb", troubleshooter: "main" };
    expect(ownerBankId("wb-dev", map)).toBe("wb");
    expect(ownerBankId("WB-DEV", map)).toBe("wb");
    expect(ownerBankId("dev", map)).toBe("dev");
    const owner = { kind: "owner-private" as const, agentId: "troubleshooter" };
    expect(routeAudience("troubleshooter", owner, map)).toMatchObject({
      ok: true,
      bankId: "main",
    });
    expect(conversationBankId("wb-dev", "agent:wb-dev:telegram:group:-1", map)).toMatch(
      /^wb::conv::[0-9a-f]{16}$/,
    );
  });
});

describe("bank ids", () => {
  it("keeps ids made of a-z0-9_- byte-identical to the previous encoded output", () => {
    for (const id of ["main", "dev", "openclaw", "wb", "researcher", "a-b_c9"]) {
      expect(ownerBankId(id)).toBe(encodeURIComponent(id));
      expect(ownerBankId(id)).toBe(id);
      expect(conversationBankId(id, "k")).toMatch(new RegExp(`^${id}::conv::[0-9a-f]{16}$`));
    }
  });

  it("returns a mapped bank id raw so the client encodes it exactly once", () => {
    expect(ownerBankId("dev", { dev: "team/shared" })).toBe("team/shared");
  });
});
