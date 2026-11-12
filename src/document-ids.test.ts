import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { runDocumentId, sessionDocumentPrefix, sessionKeyDigest } from "./document-ids.js";

const digest = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 12);

describe("auto-retain document ids", () => {
  it("are openclaw:<sanitized session>-<12 hex of the raw key>:run:<run>", () => {
    const key = "agent:dev:telegram:direct:42";
    expect(sessionKeyDigest(key)).toBe(digest(key));
    expect(runDocumentId(key, "run-1")).toBe(`openclaw:${key}-${digest(key)}:run:run-1`);
    expect(runDocumentId("agent:dev:a b/c", "r 1")).toBe(
      `openclaw:agent:dev:a_b_c-${digest("agent:dev:a b/c")}:run:r_1`,
    );
  });

  it("share the session prefix, which no other session's ids start with", () => {
    const key = "agent:dev:telegram:direct:42";
    expect(sessionDocumentPrefix(key)).toBe(`openclaw:${key}-${digest(key)}:run:`);
    expect(runDocumentId(key, "x").startsWith(sessionDocumentPrefix(key))).toBe(true);
    expect(runDocumentId(`${key}0`, "x").startsWith(sessionDocumentPrefix(key))).toBe(false);
  });

  it("fall back for an empty session or run", () => {
    expect(runDocumentId(undefined, undefined, () => "1700")).toBe(
      `openclaw:session-${digest("")}:run:1700`,
    );
  });
});
