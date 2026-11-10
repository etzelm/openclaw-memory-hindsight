import { describe, expect, it } from "vitest";
import { hindsightConfigSchema } from "./config.js";
import {
  conversationBankId,
  isMaintenanceTurn,
  matchesSessionPattern,
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

describe("isMaintenanceTurn", () => {
  it("matches the flush trigger and Active Memory recall children only", () => {
    expect(isMaintenanceTurn({ trigger: "memory", sessionKey: "agent:main:main" })).toBe(true);
    expect(
      isMaintenanceTurn({ sessionKey: "agent:main:dashboard:abc:active-memory:0123456789ab" }),
    ).toBe(true);
    expect(isMaintenanceTurn({ trigger: "user", sessionKey: "agent:main:main" })).toBe(false);
    expect(isMaintenanceTurn({ trigger: "manual", sessionKey: "agent:main:dashboard:abc" })).toBe(
      false,
    );
    // A user-named session that only mentions active-memory is a normal session.
    expect(isMaintenanceTurn({ sessionKey: "agent:main:dashboard:active-memory:notes" })).toBe(
      false,
    );
    expect(isMaintenanceTurn({})).toBe(false);
  });
});

describe("session patterns", () => {
  const parse = (extra: Record<string, unknown>) =>
    hindsightConfigSchema.parse({
      hindsightApiUrl: "http://h",
      allowInsecureHttp: true,
      ...extra,
    });
  const use = (
    cfg: ReturnType<typeof parse>,
    sessionKey: string | undefined,
    purpose: "recall" | "retain",
    messageProvider?: string,
  ) => sessionUsesMemory(cfg, { sessionKey, messageProvider, purpose });

  it("matches `*` within one segment and `**` across colons", () => {
    expect(matchesSessionPattern("agent:dev:main", ["agent:*:main"])).toBe(true);
    expect(matchesSessionPattern("agent:dev:subagent:abc", ["agent:dev:*"])).toBe(false);
    expect(matchesSessionPattern("agent:dev:subagent:abc", ["agent:dev:**"])).toBe(true);
    expect(matchesSessionPattern("agent:dev:subagent:abc", ["agent:dev:subagent:*"])).toBe(true);
    expect(matchesSessionPattern("agent:dev:subagent:a:b", ["agent:dev:subagent:*"])).toBe(false);
    expect(matchesSessionPattern("anything:at:all", ["**"])).toBe(true);
    expect(matchesSessionPattern("a:b", ["*"])).toBe(false);
  });

  it("treats everything else literally and escapes regex characters", () => {
    expect(matchesSessionPattern("agent:dev.main", ["agent:dev.main"])).toBe(true);
    expect(matchesSessionPattern("agent:devXmain", ["agent:dev.main"])).toBe(false);
    expect(matchesSessionPattern("a+b(c)[d]{1}|e^$", ["a+b(c)[d]{1}|e^$"])).toBe(true);
    expect(matchesSessionPattern("aab", ["a+b"])).toBe(false);
    expect(matchesSessionPattern("x:agent:dev:main", ["agent:dev:main"])).toBe(false);
    expect(matchesSessionPattern("agent:dev:main:x", ["agent:dev:main"])).toBe(false);
  });

  it("matches the trimmed key and never matches a missing or blank key", () => {
    expect(matchesSessionPattern("  agent:dev:main \n", ["agent:dev:main"])).toBe(true);
    expect(matchesSessionPattern(undefined, ["**"])).toBe(false);
    expect(matchesSessionPattern("   ", ["**"])).toBe(false);
    expect(matchesSessionPattern("agent:dev:main", [])).toBe(false);
  });

  it("ignore patterns block recall and retain", () => {
    const cfg = parse({ ignoreSessionPatterns: ["agent:dev:telegram:**"] });
    expect(use(cfg, "agent:dev:telegram:group:-1", "recall")).toBe(false);
    expect(use(cfg, "agent:dev:telegram:group:-1", "retain")).toBe(false);
    expect(use(cfg, "agent:dev:main", "recall")).toBe(true);
  });

  it("ignore beats recall-only", () => {
    const cfg = parse({
      ignoreSessionPatterns: ["agent:dev:subagent:secret*"],
      recallOnlySessionPatterns: ["agent:dev:subagent:**"],
    });
    expect(use(cfg, "agent:dev:subagent:secret1", "recall")).toBe(false);
    expect(use(cfg, "agent:dev:subagent:other", "recall")).toBe(true);
  });

  it("recall-only recalls through skipOperationalSessions but never retains", () => {
    const cfg = parse({ recallOnlySessionPatterns: ["agent:dev:subagent:**"] });
    expect(cfg.skipOperationalSessions).toBe(true);
    expect(use(cfg, "agent:dev:subagent:abc", "recall")).toBe(true);
    expect(use(cfg, "agent:dev:subagent:abc", "retain")).toBe(false);
  });

  it("excludeProviders, temp: and the default filters still apply first", () => {
    const cfg = parse({
      excludeProviders: ["heartbeat"],
      recallOnlySessionPatterns: ["**"],
    });
    expect(use(cfg, "agent:dev:main", "recall", "heartbeat")).toBe(false);
    expect(use(cfg, "temp:x", "recall")).toBe(false);
  });

  it("leaves unmatched sessions on today's behaviour", () => {
    const cfg = parse({ recallOnlySessionPatterns: ["agent:other:**"] });
    expect(use(cfg, "agent:dev:subagent:abc", "recall")).toBe(false);
    expect(use(cfg, "agent:dev:cron:n:r", "retain")).toBe(false);
    expect(use(cfg, "agent:dev:main", "recall")).toBe(true);
    expect(use(cfg, "agent:dev:main", "retain")).toBe(true);
    expect(use(cfg, undefined, "retain")).toBe(true);
    const open = parse({
      skipOperationalSessions: false,
      recallOnlySessionPatterns: ["agent:other:**"],
    });
    expect(use(open, "agent:dev:subagent:abc", "retain")).toBe(true);
  });
});
