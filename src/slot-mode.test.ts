import { describe, expect, it } from "vitest";
import {
  activeMemoryChatType,
  activeMemoryCoverage,
  configuredMemorySlot,
  isSlotMode,
  refusedOwner,
  registrationPlan,
  resolveSlotRole,
  slotDoctorLine,
} from "./slot-mode.js";

const ID = "hindsight-native";
const host = (memory?: unknown) =>
  memory === undefined ? { plugins: {} } : { plugins: { slots: { memory } } };

describe("configuredMemorySlot", () => {
  it("defaults to memory-core when the slot is unset, blank or not a string", () => {
    expect(configuredMemorySlot(undefined)).toBe("memory-core");
    expect(configuredMemorySlot({})).toBe("memory-core");
    expect(configuredMemorySlot(host())).toBe("memory-core");
    expect(configuredMemorySlot(host("  "))).toBe("memory-core");
    expect(configuredMemorySlot(host(42))).toBe("memory-core");
  });

  it("is null when memory is off", () => {
    expect(configuredMemorySlot(host(null))).toBeNull();
    expect(configuredMemorySlot(host("none"))).toBeNull();
    expect(configuredMemorySlot(host(" NONE "))).toBeNull();
  });

  it("normalizes case and whitespace like the host", () => {
    expect(configuredMemorySlot(host(" Hindsight-Native "))).toBe(ID);
  });
});

describe("resolveSlotRole", () => {
  it("auto owns the slot when it names this plugin, else runs as sidecar", () => {
    expect(resolveSlotRole({ mode: "auto", hostConfig: host(ID), pluginId: ID })).toEqual({
      mode: "auto",
      role: "owner",
      slot: ID,
    });
    expect(
      resolveSlotRole({ mode: "auto", hostConfig: host("memory-core"), pluginId: ID }),
    ).toEqual({ mode: "auto", role: "sidecar", slot: "memory-core" });
    expect(resolveSlotRole({ mode: "auto", hostConfig: host("none"), pluginId: ID })).toEqual({
      mode: "auto",
      role: "sidecar",
      slot: null,
    });
  });

  it("auto with no slot set is the owner: a kind memory build only loads as the owner", () => {
    expect(resolveSlotRole({ mode: "auto", hostConfig: host(), pluginId: ID })).toEqual({
      mode: "auto",
      role: "owner",
      slot: ID,
    });
    expect(resolveSlotRole({ mode: "auto", hostConfig: undefined, pluginId: ID }).role).toBe(
      "owner",
    );
  });

  it("auto with no slot set but an approved sidecar entry runs as sidecar", () => {
    const cfg = { plugins: { entries: { [ID]: { memory: { sidecar: true } } } } };
    expect(resolveSlotRole({ mode: "auto", hostConfig: cfg, pluginId: ID })).toEqual({
      mode: "auto",
      role: "sidecar",
      slot: "memory-core",
    });
  });

  it("refusedOwner turns an owner resolution into a sidecar beside memory-core", () => {
    expect(
      refusedOwner(resolveSlotRole({ mode: "auto", hostConfig: host(), pluginId: ID }), ID),
    ).toEqual({ mode: "auto", role: "sidecar", slot: "memory-core" });
    expect(
      refusedOwner({ mode: "replace", role: "owner", slot: "other", conflict: "x" }, ID),
    ).toEqual({ mode: "replace", role: "sidecar", slot: "other" });
  });

  it("replace without the slot is a conflict but keeps the owner role", () => {
    const r = resolveSlotRole({ mode: "replace", hostConfig: host("memory-core"), pluginId: ID });
    expect(r.role).toBe("owner");
    expect(r.conflict).toContain('"memory-core"');
    expect(resolveSlotRole({ mode: "replace", hostConfig: host(ID), pluginId: ID }).conflict).toBe(
      undefined,
    );
  });

  it("sidecar that names itself in the slot is a conflict", () => {
    const r = resolveSlotRole({ mode: "sidecar", hostConfig: host(ID), pluginId: ID });
    expect(r.role).toBe("sidecar");
    expect(r.conflict).toContain("no memory runtime serves memory_search");
    expect(
      resolveSlotRole({ mode: "sidecar", hostConfig: host(), pluginId: ID }).conflict,
    ).toBeUndefined();
    expect(resolveSlotRole({ mode: "replace", hostConfig: host(), pluginId: ID })).toEqual({
      mode: "replace",
      role: "owner",
      slot: ID,
    });
  });
});

describe("registrationPlan", () => {
  it("owner registers the capability and /learn, never supplements", () => {
    expect(
      registrationPlan("owner", { memoryPromptSection: true, corpusSupplement: true }),
    ).toEqual({
      memoryCapability: true,
      learnContribution: true,
      promptSupplement: false,
      corpusSupplement: false,
    });
  });

  it("sidecar never registers the capability or /learn; supplements are opt-in", () => {
    expect(
      registrationPlan("sidecar", { memoryPromptSection: false, corpusSupplement: false }),
    ).toEqual({
      memoryCapability: false,
      learnContribution: false,
      promptSupplement: false,
      corpusSupplement: false,
    });
    expect(
      registrationPlan("sidecar", { memoryPromptSection: true, corpusSupplement: true }),
    ).toMatchObject({ memoryCapability: false, promptSupplement: true, corpusSupplement: true });
  });
});

describe("slotDoctorLine", () => {
  it("passes a sidecar beside memory-core and names it", () => {
    const line = slotDoctorLine(
      resolveSlotRole({ mode: "auto", hostConfig: host("memory-core"), pluginId: ID }),
      ID,
    );
    expect(line).toEqual({
      status: "PASS",
      text: 'memory slot: sidecar beside "memory-core" (mode auto)',
    });
  });

  it("passes the owner, fails a conflict, warns when memory is off", () => {
    expect(
      slotDoctorLine(resolveSlotRole({ mode: "replace", hostConfig: host(ID), pluginId: ID }), ID)
        .status,
    ).toBe("PASS");
    expect(
      slotDoctorLine(
        resolveSlotRole({ mode: "replace", hostConfig: host("memory-core"), pluginId: ID }),
        ID,
      ).status,
    ).toBe("FAIL");
    expect(
      slotDoctorLine(resolveSlotRole({ mode: "auto", hostConfig: host("none"), pluginId: ID }), ID)
        .status,
    ).toBe("WARN");
  });
});

const AM_COVERING = {
  enabled: true,
  config: { mode: "always", agents: ["Main"], toolsAllow: ["memory_search", "hindsight_recall"] },
};
const amHost = (entry: Record<string, unknown>, plugins: Record<string, unknown> = {}) => ({
  plugins: { ...plugins, entries: { "active-memory": entry } },
});
const DIRECT = { agentId: "main", sessionKey: "agent:main:telegram:direct:42" };
const covers = (hostConfig: unknown, turn: Record<string, string> = DIRECT) =>
  activeMemoryCoverage(hostConfig, turn, "hindsight_recall");

describe("activeMemoryCoverage", () => {
  it("covers a direct turn when every Active Memory condition is met", () => {
    expect(covers(amHost(AM_COVERING))).toEqual({
      covers: true,
      reason: "active-memory recalls with hindsight_recall",
    });
    expect(
      covers(amHost(AM_COVERING), {
        agentId: "main",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      }).covers,
    ).toBe(true);
  });

  it.each([
    [
      "mode off",
      { ...AM_COVERING, config: { ...AM_COVERING.config, mode: "off" } },
      "active-memory mode off",
    ],
    [
      "mode escalate",
      { ...AM_COVERING, config: { ...AM_COVERING.config, mode: "escalate" } },
      "active-memory mode escalate",
    ],
    [
      "mode unset (escalate default)",
      { ...AM_COVERING, config: { ...AM_COVERING.config, mode: undefined } },
      "active-memory mode escalate",
    ],
    ["entry not enabled", { config: AM_COVERING.config }, "active-memory not enabled"],
    [
      "paused",
      { ...AM_COVERING, config: { ...AM_COVERING.config, enabled: false } },
      "active-memory paused",
    ],
    [
      "agent not targeted",
      { ...AM_COVERING, config: { ...AM_COVERING.config, agents: ["dev"] } },
      "agent not targeted",
    ],
    [
      "tool not allowed",
      { ...AM_COVERING, config: { ...AM_COVERING.config, toolsAllow: ["memory_search"] } },
      "hindsight_recall not in active-memory toolsAllow",
    ],
  ] as const)("does not cover when %s", (_name, entry, reason) => {
    const got = covers(amHost(entry as Record<string, unknown>));
    expect(got.covers).toBe(false);
    expect(got.reason).toContain(reason);
  });

  it("does not cover when the plugin is not loaded (plugins off, denied, not allowed)", () => {
    expect(covers(amHost(AM_COVERING, { enabled: false })).reason).toBe("plugins disabled");
    expect(covers(amHost(AM_COVERING, { deny: ["active-memory"] })).reason).toBe(
      "active-memory denied",
    );
    expect(covers(amHost(AM_COVERING, { allow: ["hindsight-native"] })).reason).toBe(
      "active-memory not in plugins.allow",
    );
    expect(covers(amHost(AM_COVERING, { allow: ["active-memory"] })).covers).toBe(true);
    expect(covers({}).reason).toBe("active-memory not enabled");
  });

  it("does not cover group, channel, thread or unknown chats unless allowedChatTypes admits them", () => {
    for (const sessionKey of [
      "agent:main:telegram:group:-100",
      "agent:main:discord:channel:9",
      "agent:main:telegram:direct:42:thread:7",
      "agent:main:subagent:x",
    ]) {
      expect(covers(amHost(AM_COVERING), { agentId: "main", sessionKey }).covers).toBe(false);
    }
    const groups = {
      ...AM_COVERING,
      config: { ...AM_COVERING.config, allowedChatTypes: ["group"] },
    };
    expect(
      covers(amHost(groups), { agentId: "main", sessionKey: "agent:main:telegram:group:-100" })
        .covers,
    ).toBe(true);
    expect(covers(amHost(groups)).covers).toBe(false);
  });

  it("applies allowedChatIds and deniedChatIds to the turn's peer", () => {
    const denied = { ...AM_COVERING, config: { ...AM_COVERING.config, deniedChatIds: ["42"] } };
    expect(covers(amHost(denied)).reason).toBe("chat id in active-memory deniedChatIds");
    expect(
      covers(amHost(denied), { agentId: "main", sessionKey: "agent:main:telegram:direct:7" })
        .covers,
    ).toBe(true);
    const allowed = { ...AM_COVERING, config: { ...AM_COVERING.config, allowedChatIds: ["7"] } };
    expect(covers(amHost(allowed)).reason).toBe("chat id not in active-memory allowedChatIds");
    // Main session without a peer id and no channel id: unknown, so never covered.
    expect(
      covers(amHost(denied), {
        agentId: "main",
        sessionKey: "agent:main:main",
        messageProvider: "webchat",
      }).reason,
    ).toBe("chat id unknown with active-memory chat id lists set");
  });

  it("reads the chat type like Active Memory", () => {
    expect(activeMemoryChatType({ sessionKey: "agent:main:explicit:x" })).toBe("explicit");
    expect(
      activeMemoryChatType({
        sessionKey: "agent:main:main",
        messageProvider: "telegram",
        channelId: "42",
      }),
    ).toBe("direct");
    expect(
      activeMemoryChatType({ sessionKey: "agent:main:main", messageProvider: "telegram" }),
    ).toBeUndefined();
    expect(
      activeMemoryChatType(
        { sessionKey: "agent:main:home", messageProvider: "telegram", channelId: "1" },
        "home",
      ),
    ).toBe("direct");
  });
});

it("isSlotMode accepts the three modes only", () => {
  expect(["auto", "replace", "sidecar"].every(isSlotMode)).toBe(true);
  expect(isSlotMode("hybrid")).toBe(false);
  expect(isSlotMode(undefined)).toBe(false);
});
