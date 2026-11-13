import { describe, expect, it } from "vitest";
import {
  checkAnchor,
  checkRunDocument,
  chunkBelongsTo,
  isPrivateConversation,
  isTrustedRecallRequester,
  readConversationRecallGrant,
  type SessionSnapshot,
  type StoredSession,
} from "./conversation-recall-policy.js";
import { runDocumentId } from "./document-ids.js";

const ANCHOR = "agent:dev:telegram:direct:42";
const OTHER = "agent:dev:dashboard:prior";
const GRANT = {
  anchorSessionKey: ANCHOR,
  scope: "same-agent-private",
  corpus: "sessions",
} as const;
const agentOf = (key: string) => /^agent:([^:]+):/.exec(key)?.[1];

function row(sessionKey: string, sessionId: string, chatTypes: string[] = ["direct"]) {
  return { sessionKey, sessionId, chatTypes } satisfies StoredSession;
}
function snap(...rows: StoredSession[]): SessionSnapshot {
  return new Map(rows.map((r) => [r.sessionKey, r]));
}
function doc(key: string, meta: Record<string, string> = {}, run = "r1") {
  return {
    id: runDocumentId(key, run),
    metadata: {
      source: "openclaw",
      retention_scope: "turn",
      audience: "owner-private",
      agent_id: "dev",
      session_key: key,
      session_id: "s-other",
      sandboxed: "false",
      ...meta,
    },
  };
}

describe("readConversationRecallGrant (R4, R5)", () => {
  it("accepts only the host grant shape", () => {
    expect(readConversationRecallGrant(GRANT)).toEqual(GRANT);
    expect(readConversationRecallGrant({ ...GRANT, corpus: "configured" })?.corpus).toBe(
      "configured",
    );
    expect(readConversationRecallGrant({ ...GRANT, scope: "all" })).toBeUndefined();
    expect(readConversationRecallGrant({ ...GRANT, corpus: "memory" })).toBeUndefined();
    expect(readConversationRecallGrant({ ...GRANT, anchorSessionKey: "  " })).toBeUndefined();
    expect(readConversationRecallGrant(undefined)).toBeUndefined();
    expect(readConversationRecallGrant("x")).toBeUndefined();
  });
});

describe("isTrustedRecallRequester (R6)", () => {
  it("is the anchor or its Active Memory recall run only", () => {
    expect(isTrustedRecallRequester(ANCHOR, ANCHOR)).toBe(true);
    expect(isTrustedRecallRequester(ANCHOR, `${ANCHOR}:active-memory:0123456789ab`)).toBe(true);
    expect(isTrustedRecallRequester(ANCHOR, `${ANCHOR}:active-memory:xyz`)).toBe(false);
    expect(isTrustedRecallRequester(ANCHOR, `${ANCHOR}:subagent:1`)).toBe(false);
    expect(isTrustedRecallRequester(ANCHOR, "agent:dev:other")).toBe(false);
    expect(isTrustedRecallRequester(ANCHOR, undefined)).toBe(false);
  });
});

describe("isPrivateConversation (R8, R16)", () => {
  const cases: Array<[string, string[] | undefined, boolean]> = [
    ["agent:dev:telegram:direct:42", [], true],
    ["agent:dev:telegram:dm:42", [], true],
    ["agent:dev:dashboard:abc", ["direct"], true],
    ["agent:dev:dashboard:abc", [], false],
    ["agent:dev:telegram:direct:42", ["direct", "group"], false],
    ["agent:dev:discord:channel:7", [], false],
    ["agent:dev:telegram:group:-100", ["direct"], false],
    ["agent:dev:x", ["channel"], false],
    ["agent:dev:global", ["direct"], false],
    ["global", ["direct"], false],
    ["agent:dev:explicit:ui", ["direct"], true],
    ["agent:dev:explicit:ui", [], false],
    ["agent:dev:explicit:ui", ["direct", "group"], false],
    ["agent:dev:cron:nightly", ["direct"], false],
    ["agent:dev:heartbeat", ["direct"], false],
    ["agent:dev:hook:gmail:direct:1", ["direct"], false],
    ["agent:dev:node:studio", ["direct"], false],
    ["agent:dev:subagent:abc", ["direct"], false],
    ["agent:dev:telegram:direct:42:active-memory:0123456789ab", ["direct"], false],
    ["agent:dev:telegram:direct:42", undefined, false],
  ];
  it.each(cases)("%s %j -> %s", (key, chatTypes, expected) => {
    const entry = chatTypes ? row(key, "s", chatTypes) : undefined;
    expect(isPrivateConversation("dev", key, entry)).toBe(expected);
  });
});

describe("checkAnchor (R2, R3, R6, R7, R8, R9)", () => {
  const base = {
    grant: GRANT,
    requesterSessionKey: `${ANCHOR}:active-memory:0123456789ab`,
    sandboxed: false,
    scopedAgentId: "dev",
    resolveAgentId: agentOf,
    snapshot: snap(row(ANCHOR, "s-anchor")),
  };
  it("authorizes a private anchor of the same agent", () => {
    expect(checkAnchor(base)).toMatchObject({ ok: true, agentId: "dev" });
  });
  it("refuses without grant, sandboxed, untrusted, other agent, missing or shared anchor", () => {
    expect(checkAnchor({ ...base, grant: undefined }).ok).toBe(false);
    expect(checkAnchor({ ...base, sandboxed: true }).ok).toBe(false);
    expect(checkAnchor({ ...base, requesterSessionKey: undefined }).ok).toBe(false);
    expect(checkAnchor({ ...base, requesterSessionKey: "agent:dev:main" }).ok).toBe(false);
    expect(checkAnchor({ ...base, scopedAgentId: "main" }).ok).toBe(false);
    expect(checkAnchor({ ...base, snapshot: snap() }).ok).toBe(false);
    expect(checkAnchor({ ...base, snapshot: snap(row(ANCHOR, "s-anchor", ["group"])) }).ok).toBe(
      false,
    );
  });
  it("refuses an anchor whose transcript also lives under a group key", () => {
    const snapshot = snap(
      row(ANCHOR, "s-anchor"),
      row("agent:dev:telegram:group:-100", "s-anchor", ["group"]),
    );
    expect(checkAnchor({ ...base, snapshot })).toMatchObject({ ok: false });
  });
});

describe("checkRunDocument (R10-R17, R21)", () => {
  const anchor = row(ANCHOR, "s-anchor");
  const base = {
    agentId: "dev",
    anchor,
    snapshot: snap(anchor, row(OTHER, "s-other")),
    resolveAgentId: agentOf,
  };
  it("admits the live generation of another private session", () => {
    expect(checkRunDocument({ ...base, doc: doc(OTHER) })).toEqual({ ok: true, sessionKey: OTHER });
  });
  it.each([
    [
      "not a run document",
      { id: "openclaw:agent:dev:dashboard:prior", metadata: doc(OTHER).metadata },
    ],
    ["id of another session", { ...doc(OTHER), id: runDocumentId("agent:dev:dashboard:x", "r1") }],
    ["memory note", doc(OTHER, { source: "hindsight_retain" })],
    ["flush", doc(OTHER, { retention_scope: "flush" })],
    ["group bank audience", doc(OTHER, { audience: "conversation" })],
    ["sandboxed run", doc(OTHER, { sandboxed: "true" })],
    ["other agent metadata", doc(OTHER, { agent_id: "main" })],
    ["legacy doc without session_id", doc(OTHER, { session_id: "" })],
    ["the anchor key", doc(ANCHOR, { session_id: "s-anchor" })],
    ["anchor transcript under an alias", doc(OTHER, { session_id: "s-anchor" })],
  ])("refuses %s", (_label, candidate) => {
    expect(checkRunDocument({ ...base, doc: candidate }).ok).toBe(false);
  });
  it("refuses a deleted session and an earlier generation (reset or recreated key)", () => {
    expect(checkRunDocument({ ...base, snapshot: snap(anchor), doc: doc(OTHER) }).ok).toBe(false);
    expect(
      checkRunDocument({ ...base, doc: doc(OTHER, { session_id: "s-before-reset" }) }).ok,
    ).toBe(false);
  });
  it("refuses an earlier generation of the anchor itself (pre-reset chunk)", () => {
    expect(
      checkRunDocument({ ...base, doc: doc(ANCHOR, { session_id: "s-anchor-before-reset" }) }).ok,
    ).toBe(false);
  });
  it("refuses a group chat, another agent's key, and a private key with a group alias", () => {
    const group = "agent:dev:telegram:group:-100";
    expect(
      checkRunDocument({
        ...base,
        snapshot: snap(anchor, row(group, "s-g", ["group"])),
        doc: doc(group, { session_id: "s-g" }),
      }).ok,
    ).toBe(false);
    const foreign = "agent:main:dashboard:prior";
    expect(
      checkRunDocument({
        ...base,
        snapshot: snap(anchor, row(foreign, "s-f")),
        doc: doc(foreign, { session_id: "s-f" }),
      }).ok,
    ).toBe(false);
    expect(
      checkRunDocument({
        ...base,
        snapshot: snap(anchor, row(OTHER, "s-other"), row(group, "s-other", ["group"])),
        doc: doc(OTHER),
      }).ok,
    ).toBe(false);
  });
  it("refuses a session whose key now belongs to a group delivery", () => {
    expect(
      checkRunDocument({
        ...base,
        snapshot: snap(anchor, row(OTHER, "s-other", ["direct", "group"])),
        doc: doc(OTHER),
      }).ok,
    ).toBe(false);
  });
});

describe("chunkBelongsTo (R10)", () => {
  it("ties a chunk to its bank and document", () => {
    const id = runDocumentId(OTHER, "r1");
    expect(chunkBelongsTo(`dev_${id}_3`, "dev", id)).toBe(true);
    expect(chunkBelongsTo(`dev_${id}_x`, "dev", id)).toBe(false);
    expect(chunkBelongsTo(`main_${id}_3`, "dev", id)).toBe(false);
    expect(chunkBelongsTo(`dev_${id}_1_2`, "dev", id)).toBe(false);
  });
});
