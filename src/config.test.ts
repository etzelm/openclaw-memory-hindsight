import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECALL_PROMPT_PREAMBLE,
  hasUnresolvedToken,
  hindsightConfigSchema,
  isPlainHttpRemote,
  recallFilterFor,
} from "./config.js";

describe("hindsightConfigSchema", () => {
  it("requires an http(s) API url and applies defaults", () => {
    expect(() => hindsightConfigSchema.parse({})).toThrow(/hindsightApiUrl is required/);
    expect(() => hindsightConfigSchema.parse({ hindsightApiUrl: "ftp://x" })).toThrow(/http/);
    const cfg = hindsightConfigSchema.parse({
      hindsightApiUrl: "http://studio:8888/",
      allowInsecureHttp: true,
    });
    expect(cfg).toMatchObject({
      apiUrl: "http://studio:8888",
      memoryMode: "hybrid",
      autoRecall: true,
      autoRetain: true,
      recallBudget: "mid",
      recallPromptPreamble: DEFAULT_RECALL_PROMPT_PREAMBLE,
      excludeProviders: [],
      skipOperationalSessions: true,
    });
    expect(cfg.apiToken).toBeUndefined();
  });

  it("rejects unknown keys and invalid enums", () => {
    expect(() =>
      hindsightConfigSchema.parse({
        hindsightApiUrl: "http://h",
        allowInsecureHttp: true,
        llmApiKey: "x",
      }),
    ).toThrow(/unknown keys: llmApiKey/);
    expect(() =>
      hindsightConfigSchema.parse({
        hindsightApiUrl: "http://h",
        allowInsecureHttp: true,
        memoryMode: "files",
      }),
    ).toThrow(/memoryMode/);
    expect(() =>
      hindsightConfigSchema.parse({
        hindsightApiUrl: "http://h",
        allowInsecureHttp: true,
        recallTypes: ["opinion"],
      }),
    ).toThrow(/recallTypes/);
  });

  it("keeps a resolved token and ignores an unresolved SecretRef object", () => {
    expect(
      hindsightConfigSchema.parse({
        hindsightApiUrl: "http://h",
        allowInsecureHttp: true,
        hindsightApiToken: " t0k ",
      }).apiToken,
    ).toBe("t0k");
    expect(
      hindsightConfigSchema.parse({
        hindsightApiUrl: "http://h",
        allowInsecureHttp: true,
        hindsightApiToken: { source: "file", provider: "p", id: "x" },
      }).apiToken,
    ).toBeUndefined();
  });

  it("rejects a token with a control, space or non-ASCII character without echoing it", () => {
    for (const token of [
      "SECRETPART1\nSECRETPART2",
      "SECRETPART1\rSECRETPART2",
      "SECRETPART1\tSECRETPART2",
      "SECRETPART1 SECRETPART2",
      "SECRETPART1\u0000SECRETPART2",
      "SECRETPART1\u007fSECRETPART2",
      "SECRETPART1\u00e9SECRETPART2",
      "SECRETPART1\u0100SECRETPART2",
    ]) {
      let message = "";
      try {
        hindsightConfigSchema.parse({
          hindsightApiUrl: "http://h",
          allowInsecureHttp: true,
          hindsightApiToken: token,
        });
      } catch (error) {
        message = String((error as Error).message);
      }
      expect(message).toMatch(/hindsightApiToken/);
      expect(message).not.toMatch(/SECRETPART/);
    }
  });

  it("still accepts a printable ASCII token and trims a trailing newline", () => {
    expect(
      hindsightConfigSchema.parse({
        hindsightApiUrl: "http://h",
        allowInsecureHttp: true,
        hindsightApiToken: "hs_A-b.c~d+e/f=g\n",
      }).apiToken,
    ).toBe("hs_A-b.c~d+e/f=g");
  });

  it("rejects an api url with userinfo, a query string or a fragment", () => {
    expect(() =>
      hindsightConfigSchema.parse({
        hindsightApiUrl: "http://user:pw@h:8888",
        allowInsecureHttp: true,
      }),
    ).toThrow(/must not contain credentials/);
    expect(() =>
      hindsightConfigSchema.parse({
        hindsightApiUrl: "http://user@h",
        allowInsecureHttp: true,
      }),
    ).toThrow(/credentials/);
    expect(() =>
      hindsightConfigSchema.parse({
        hindsightApiUrl: "http://h?token=x",
        allowInsecureHttp: true,
      }),
    ).toThrow(/query string or fragment/);
    expect(() =>
      hindsightConfigSchema.parse({
        hindsightApiUrl: "http://h#frag",
        allowInsecureHttp: true,
      }),
    ).toThrow(/query string or fragment/);
  });

  it.each([
    ["bare trailing ?", "http://h?"],
    ["bare trailing # after a path", "http://h/api#"],
    ["empty query and fragment", "http://h/?#"],
    ["bare ? after a port and path", "http://h:8888/v1?"],
  ])("rejects an api url with an empty query or fragment: %s", (_label, hindsightApiUrl) => {
    expect(() => hindsightConfigSchema.parse({ hindsightApiUrl, allowInsecureHttp: true })).toThrow(
      "hindsightApiUrl must not contain a query string or fragment",
    );
  });

  it("detects unresolved tokens and plain-http remote hosts", () => {
    expect(hasUnresolvedToken({ hindsightApiToken: { source: "file", id: "x" } })).toBe(true);
    expect(hasUnresolvedToken({ hindsightApiToken: "t" })).toBe(false);
    expect(hasUnresolvedToken({})).toBe(false);
    expect(isPlainHttpRemote("http://studio:8888")).toBe(true);
    expect(isPlainHttpRemote("https://studio")).toBe(false);
    for (const url of ["http://localhost:1", "http://127.0.0.1:1", "http://[::1]:1"]) {
      expect(isPlainHttpRemote(url)).toBe(false);
    }
  });

  it("refuses plain http to a remote host unless allowInsecureHttp is true", () => {
    for (const hindsightApiUrl of ["http://studio:8888", "http://10.0.0.5", "http://[::2]:1"]) {
      expect(() => hindsightConfigSchema.parse({ hindsightApiUrl })).toThrow(/allowInsecureHttp/);
      expect(() => hindsightConfigSchema.parse({ hindsightApiUrl })).toThrow(/unencrypted/);
    }
    expect(() =>
      hindsightConfigSchema.parse({
        hindsightApiUrl: "http://h",
        allowInsecureHttp: "yes",
      }),
    ).toThrow(/allowInsecureHttp/);
    const cfg = hindsightConfigSchema.parse({
      hindsightApiUrl: "http://studio:8888",
      allowInsecureHttp: true,
    });
    expect(cfg.allowInsecureHttp).toBe(true);
  });

  it("pins host matching: case-insensitive loopback, fail closed on lookalikes", () => {
    expect(hindsightConfigSchema.parse({ hindsightApiUrl: "http://LOCALHOST:1" }).apiUrl).toBe(
      "http://LOCALHOST:1",
    );
    for (const hindsightApiUrl of [
      "http://[::ffff:127.0.0.1]:1",
      "http://localhost.evil.com",
      "HTTP://studio:1",
    ]) {
      expect(() => hindsightConfigSchema.parse({ hindsightApiUrl })).toThrow(/allowInsecureHttp/);
    }
  });

  it("allows loopback http and https without the flag", () => {
    for (const hindsightApiUrl of [
      "http://localhost:8888",
      "http://127.0.0.5:8888",
      "http://[::1]:8888",
      "https://studio.example",
    ]) {
      expect(hindsightConfigSchema.parse({ hindsightApiUrl }).allowInsecureHttp).toBe(false);
    }
  });

  it("parses the live third-party config subset and rejects dropped options", () => {
    const cfg = hindsightConfigSchema.parse({
      hindsightApiUrl: "http://hindsight.example:8888",
      allowInsecureHttp: true,
      recallTypes: ["observation", "world", "experience"],
      preferObservations: true,
      recallBudget: "mid",
      excludeProviders: ["heartbeat"],
      retainMission: "Extract durable facts.",
    });
    expect(cfg.recallTypes).toEqual(["observation", "world", "experience"]);
    expect(cfg.excludeProviders).toEqual(["heartbeat"]);
    expect(cfg.retainMission).toBe("Extract durable facts.");
    expect(() =>
      hindsightConfigSchema.parse({
        hindsightApiUrl: "http://h",
        allowInsecureHttp: true,
        recallInjectionPosition: "user",
      }),
    ).toThrow(/unknown keys: recallInjectionPosition/);
  });
});

describe("retainTags", () => {
  const base = { hindsightApiUrl: "http://h", allowInsecureHttp: true };

  it("defaults to no tags and keeps a trimmed, deduplicated list", () => {
    expect(hindsightConfigSchema.parse(base).retainTags).toEqual([]);
    expect(
      hindsightConfigSchema.parse({
        ...base,
        retainTags: [" source:openclaw ", "source:openclaw", "", "team:ops"],
      }).retainTags,
    ).toEqual(["source:openclaw", "team:ops"]);
  });

  it("is declared in the manifest config schema", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema: { properties: Record<string, unknown> } };
    expect(manifest.configSchema.properties.retainTags).toEqual({
      type: "array",
      items: { type: "string" },
    });
  });

  it("accepts a vendor config once the keys without an equivalent are removed", () => {
    const vendor = {
      hindsightApiUrl: "https://hindsight.example",
      hindsightApiToken: { source: "file", provider: "hindsight", id: "value" },
      skipOperationalSessions: true,
      retainMission: "Extract durable facts.",
      recallTypes: ["observation", "world", "experience"],
      preferObservations: true,
      agentBankMap: { troubleshooter: "main", "wb-dev": "wb", "wb-dev2": "wb", "wb-review": "wb" },
      retainTags: ["source:openclaw"],
      retainContext: "Transcript from OpenClaw.",
    };
    const dropped = {
      debugPerfTiming: true,
      dynamicBankGranularity: ["agent"],
      retainToolCalls: false,
    };
    expect(() => hindsightConfigSchema.parse({ ...vendor, ...dropped })).toThrow(
      /unknown keys: debugPerfTiming, dynamicBankGranularity, retainToolCalls/,
    );
    const cfg = hindsightConfigSchema.parse(vendor);
    expect(cfg.retainTags).toEqual(["source:openclaw"]);
    expect(cfg.agentBankMap).toEqual(vendor.agentBankMap);
  });

  it("rejects a value that is not an array of strings", () => {
    expect(() => hindsightConfigSchema.parse({ ...base, retainTags: "source:openclaw" })).toThrow(
      /retainTags must be an array of strings/,
    );
    expect(() => hindsightConfigSchema.parse({ ...base, retainTags: [1] })).toThrow(/retainTags/);
  });
});

describe("agentBankMap", () => {
  it("parses the vendor-compatible map and rejects bad entries", () => {
    const base = { hindsightApiUrl: "http://h", allowInsecureHttp: true };
    expect(hindsightConfigSchema.parse(base).agentBankMap).toEqual({});
    expect(
      hindsightConfigSchema.parse({
        ...base,
        agentBankMap: { " WB-Dev ": " wb " },
      }).agentBankMap,
    ).toEqual({ "wb-dev": "wb" });
    expect(() => hindsightConfigSchema.parse({ ...base, agentBankMap: ["wb"] })).toThrow(
      /agentBankMap/,
    );
    expect(() => hindsightConfigSchema.parse({ ...base, agentBankMap: { dev: "" } })).toThrow(
      /agentBankMap/,
    );
  });
});

describe("agentBankMap hardening", () => {
  const base = { hindsightApiUrl: "http://h", allowInsecureHttp: true };
  it('rejects "." and ".." as a bank id', () => {
    for (const bank of [".", "..", " .. "]) {
      expect(() => hindsightConfigSchema.parse({ ...base, agentBankMap: { dev: bank } })).toThrow(
        /must not be "\." or "\.\."/,
      );
    }
    expect(
      hindsightConfigSchema.parse({ ...base, agentBankMap: { dev: "..x" } }).agentBankMap,
    ).toEqual({ dev: "..x" });
  });

  it("normalizes keys like agent ids", () => {
    const map = hindsightConfigSchema.parse({
      ...base,
      agentBankMap: { "WB Dev": "wb" },
    }).agentBankMap;
    expect(map).toEqual({ "wb-dev": "wb" });
    expect(() =>
      hindsightConfigSchema.parse({ ...base, agentBankMap: { "WB Dev": "a", "wb-dev": "b" } }),
    ).toThrow(/more than one key/);
    expect(() => hindsightConfigSchema.parse({ ...base, agentBankMap: { "!!!": "a" } })).toThrow(
      /not a valid agent id/,
    );
    expect(
      hindsightConfigSchema.parse({ ...base, agentBankMap: { Main: "a" } }).agentBankMap,
    ).toEqual({ main: "a" });
  });

  it("keeps prototype names as plain own keys", () => {
    const map = hindsightConfigSchema.parse({
      ...base,
      agentBankMap: JSON.parse('{"__proto__":"proto-bank","constructor":"ctor-bank"}') as unknown,
    }).agentBankMap;
    expect(Object.keys(map).toSorted()).toEqual(["__proto__", "constructor"]);
    expect(map.constructor).toBe("ctor-bank");
  });
});

describe("retain queue config", () => {
  it("defaults the offline retain queue on, bounded to 500 items and 7 days", () => {
    const base = { hindsightApiUrl: "http://127.0.0.1:8888" };
    expect(hindsightConfigSchema.parse(base)).toMatchObject({
      retainQueueEnabled: true,
      retainQueueMaxItems: 500,
      retainQueueMaxAgeMs: 604_800_000,
    });
    expect(
      hindsightConfigSchema.parse({
        ...base,
        retainQueueEnabled: false,
        retainQueueMaxItems: 10,
        retainQueueMaxAgeMs: 60_000,
      }),
    ).toMatchObject({
      retainQueueEnabled: false,
      retainQueueMaxItems: 10,
      retainQueueMaxAgeMs: 60_000,
    });
    for (const bad of [0, -1, 1.5, "10", 10_001]) {
      expect(() => hindsightConfigSchema.parse({ ...base, retainQueueMaxItems: bad })).toThrow(
        /retainQueueMaxItems must be an integer/,
      );
    }
    expect(() => hindsightConfigSchema.parse({ ...base, retainQueueMaxAgeMs: -1 })).toThrow(
      /retainQueueMaxAgeMs must be an integer/,
    );
    expect(() => hindsightConfigSchema.parse({ ...base, retainQueueEnabled: "yes" })).toThrow(
      /retainQueueEnabled must be a boolean/,
    );
  });
});

describe("session pattern keys", () => {
  const base = { hindsightApiUrl: "http://h", allowInsecureHttp: true };

  it("default to empty lists", () => {
    const cfg = hindsightConfigSchema.parse(base);
    expect(cfg.ignoreSessionPatterns).toEqual([]);
    expect(cfg.recallOnlySessionPatterns).toEqual([]);
  });

  it("trim, dedupe and drop blanks like other string lists", () => {
    const cfg = hindsightConfigSchema.parse({
      ...base,
      ignoreSessionPatterns: [" agent:a:** ", "agent:a:**", ""],
      recallOnlySessionPatterns: ["agent:dev:subagent:**"],
    });
    expect(cfg.ignoreSessionPatterns).toEqual(["agent:a:**"]);
    expect(cfg.recallOnlySessionPatterns).toEqual(["agent:dev:subagent:**"]);
  });

  it("rejects non-string-array values", () => {
    expect(() => hindsightConfigSchema.parse({ ...base, ignoreSessionPatterns: "x" })).toThrow(
      /ignoreSessionPatterns must be an array of strings/,
    );
    expect(() => hindsightConfigSchema.parse({ ...base, recallOnlySessionPatterns: [1] })).toThrow(
      /recallOnlySessionPatterns must be an array of strings/,
    );
  });

  it("are declared in the manifest schema", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema: { properties: Record<string, { type: string; default?: unknown }> } };
    for (const key of ["ignoreSessionPatterns", "recallOnlySessionPatterns"]) {
      expect(manifest.configSchema.properties[key]).toMatchObject({ type: "array", default: [] });
    }
  });
});

describe("recall cache keys", () => {
  const base = { hindsightApiUrl: "http://h", allowInsecureHttp: true };

  it("defaults both to 0 (off)", () => {
    const cfg = hindsightConfigSchema.parse(base);
    expect(cfg.recallCacheTtlMs).toBe(0);
    expect(cfg.recallFollowupMaxWords).toBe(0);
  });

  it("accepts in-range integers", () => {
    const cfg = hindsightConfigSchema.parse({
      ...base,
      recallCacheTtlMs: 900_000,
      recallFollowupMaxWords: 6,
    });
    expect(cfg.recallCacheTtlMs).toBe(900_000);
    expect(cfg.recallFollowupMaxWords).toBe(6);
  });

  it("rejects negative, fractional, oversized and non-number values", () => {
    for (const bad of [-1, 1.5, 3_600_001, "900000"]) {
      expect(() => hindsightConfigSchema.parse({ ...base, recallCacheTtlMs: bad })).toThrow(
        /recallCacheTtlMs must be an integer from 0 to 3600000/,
      );
    }
    for (const bad of [-1, 2.5, 101, "6"]) {
      expect(() => hindsightConfigSchema.parse({ ...base, recallFollowupMaxWords: bad })).toThrow(
        /recallFollowupMaxWords must be an integer from 0 to 100/,
      );
    }
  });

  it("declares both keys in the manifest config schema", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      configSchema: { properties: Record<string, { default?: number; description?: string }> };
    };
    for (const key of ["recallCacheTtlMs", "recallFollowupMaxWords"]) {
      expect(manifest.configSchema.properties[key]?.default).toBe(0);
      expect(manifest.configSchema.properties[key]?.description).toBeTruthy();
    }
  });
});

describe("recallTimeoutMs", () => {
  const base = { hindsightApiUrl: "http://h", allowInsecureHttp: true };

  it("defaults to the previous fixed 10 s", () => {
    expect(hindsightConfigSchema.parse(base).recallTimeoutMs).toBe(10_000);
  });

  it("accepts 250 to 30000 ms", () => {
    for (const ms of [250, 2_000, 30_000]) {
      expect(hindsightConfigSchema.parse({ ...base, recallTimeoutMs: ms }).recallTimeoutMs).toBe(
        ms,
      );
    }
  });

  it("rejects values outside the range and non-integers", () => {
    for (const bad of [0, 249, 30_001, 1.5, "2000"]) {
      expect(() => hindsightConfigSchema.parse({ ...base, recallTimeoutMs: bad })).toThrow(
        /recallTimeoutMs must be an integer from 250 to 30000/,
      );
    }
  });

  it("is declared in the manifest config schema with the same bounds", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema: { properties: Record<string, Record<string, unknown>> } };
    expect(manifest.configSchema.properties.recallTimeoutMs).toMatchObject({
      type: "integer",
      minimum: 250,
      maximum: 30_000,
      default: 10_000,
    });
  });
});

describe("recallTagGroups and recallHistoryPattern", () => {
  const base = { hindsightApiUrl: "http://h", allowInsecureHttp: true };
  const STAGED = [{ not: { tags: ["kind:status"], match: "any_strict" } }];
  const HISTORY =
    "\\b(?:history|timeline|status|progress|what happened|when did|so far|previous|earlier|changed|still)\\b";

  it("are unset by default", () => {
    const cfg = hindsightConfigSchema.parse(base);
    expect(cfg.recallTagGroups).toBeUndefined();
    expect(cfg.recallHistoryPattern).toBeUndefined();
  });

  it("accept the staged status filter and history pattern", () => {
    const cfg = hindsightConfigSchema.parse({
      ...base,
      recallTagGroups: STAGED,
      recallHistoryPattern: HISTORY,
    });
    expect(cfg.recallTagGroups).toEqual(STAGED);
    expect(cfg.recallHistoryPattern?.test("What is the STATUS of !47?")).toBe(true);
    expect(cfg.recallHistoryPattern?.test("where does hindsight run?")).toBe(false);
  });

  it("accept every Hindsight 1.2.1 group form: leaf, and, or, not, match and resolve", () => {
    const groups = [
      { tags: ["source:gitlab"] },
      { tags: ["typescript"], match: "any", resolve: "fuzzy" },
      { and: [{ tags: ["a"], match: "all_strict" }, { or: [{ tags: ["b"] }, { tags: ["c"] }] }] },
      { not: { or: [{ tags: ["kind:status"], match: "exact" }] } },
    ];
    expect(
      hindsightConfigSchema.parse({ ...base, recallTagGroups: groups }).recallTagGroups,
    ).toEqual(groups);
  });

  it("reject malformed groups with the path of the bad entry", () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ tags: ["a"] }, /recallTagGroups must be an array of tag groups/],
      [[], /recallTagGroups must hold 1 to 32 groups/],
      [["a"], /recallTagGroups\[0\] must be an object/],
      [[{ tags: [] }], /recallTagGroups\[0\]\.tags must be 1 to 32 non-empty strings/],
      [[{ tags: ["a", 1] }], /recallTagGroups\[0\]\.tags must be 1 to 32 non-empty strings/],
      [[{ tags: ["a"], match: "some" }], /recallTagGroups\[0\]\.match must be one of/],
      [[{ tags: ["a"], resolve: "loose" }], /recallTagGroups\[0\]\.resolve must be exact or fuzzy/],
      [[{ tags: ["a"], extra: 1 }], /recallTagGroups\[0\] has unknown keys: extra/],
      [[{ tags: ["a"], not: { tags: ["b"] } }], /recallTagGroups\[0\] has unknown keys: not/],
      [[{ not: { tags: ["b"] }, or: [] }], /recallTagGroups\[0\] must have exactly one of/],
      [[{}], /recallTagGroups\[0\] must have exactly one of/],
      [[{ and: [] }], /recallTagGroups\[0\]\.and must hold 1 to 32 groups/],
      [[{ or: [{ tags: ["a"] }, { bogus: 1 }] }], /recallTagGroups\[0\]\.or\[1\] must have/],
    ];
    for (const [value, message] of bad) {
      expect(() => hindsightConfigSchema.parse({ ...base, recallTagGroups: value })).toThrow(
        message,
      );
    }
  });

  it("reject groups nested deeper than 8 levels", () => {
    let group: Record<string, unknown> = { tags: ["a"] };
    for (let i = 0; i < 8; i++) {
      group = { not: group };
    }
    expect(() => hindsightConfigSchema.parse({ ...base, recallTagGroups: [group] })).toThrow(
      /recallTagGroups nests deeper than 8 levels/,
    );
    expect(() =>
      hindsightConfigSchema.parse({ ...base, recallTagGroups: [(group as { not: unknown }).not] }),
    ).not.toThrow();
  });

  it("reject an empty history pattern, which would match every query (G3)", () => {
    for (const value of ["", "   "]) {
      expect(() =>
        hindsightConfigSchema.parse({
          ...base,
          recallTagGroups: STAGED,
          recallHistoryPattern: value,
        }),
      ).toThrow(/recallHistoryPattern must not be empty/);
    }
  });

  // Spec change in 0.9.0 (allowlist grammar): still refused, by the first token outside the grammar.
  it("reject a history pattern with nested quantifiers (G3)", () => {
    for (const value of [
      "(a+)+$",
      "(\\w+\\s?)*$",
      "((ab)+c)*x",
      "(?:x{2,})+y",
      "(a*){2,}b",
      "^(\\d+)+$",
    ]) {
      expect(() =>
        hindsightConfigSchema.parse({
          ...base,
          recallTagGroups: STAGED,
          recallHistoryPattern: value,
        }),
      ).toThrow(/recallHistoryPattern: ".+" at character \d+ is /);
    }
  });

  // Spec change in 0.9.0 (F3, F5, then the allowlist grammar): the vm timing probe is gone; these
  // shapes are refused by the first token outside the grammar.
  it("reject a history pattern that backtracks for too long on a worst-case query (G3)", () => {
    for (const value of ["(a|a)*$", "(\\w|\\d)+$", "(.|a)*\\n"]) {
      expect(() =>
        hindsightConfigSchema.parse({
          ...base,
          recallTagGroups: STAGED,
          recallHistoryPattern: value,
        }),
      ).toThrow(/recallHistoryPattern: ".+" at character \d+ is /);
    }
  });

  it("tests the history pattern on the first 800 characters of a query only (G3)", () => {
    const cfg = hindsightConfigSchema.parse({
      ...base,
      recallTagGroups: STAGED,
      recallHistoryPattern: "zzz",
    });
    expect(recallFilterFor(cfg, `${"a".repeat(790)}zzz`)).toEqual({});
    expect(recallFilterFor(cfg, `${"a".repeat(800)}zzz`)).toEqual({ tagGroups: STAGED });
  });

  // Spec change in 0.9.0 (allowlist grammar): no quantifiers, classes or capture groups.
  it("accept the README pattern and other plain patterns (G3)", () => {
    for (const value of [
      HISTORY,
      "(?:status|progress)\\sreport",
      "\\b(?:when|since)\\b",
      "\\+\\*",
    ]) {
      const cfg = hindsightConfigSchema.parse({
        ...base,
        recallTagGroups: STAGED,
        recallHistoryPattern: value,
      });
      expect(cfg.recallHistoryPattern?.source).toBe(value);
    }
  });

  it("reject a history pattern without groups, a bad regex, or one over 500 characters", () => {
    expect(() => hindsightConfigSchema.parse({ ...base, recallHistoryPattern: HISTORY })).toThrow(
      /recallHistoryPattern needs recallTagGroups/,
    );
    for (const [value, message] of [
      ["(unclosed", /recallHistoryPattern is not a valid regular expression/],
      ["a".repeat(501), /recallHistoryPattern must be at most 500 characters/],
      [42, /recallHistoryPattern must be a string/],
    ] as const) {
      expect(() =>
        hindsightConfigSchema.parse({
          ...base,
          recallTagGroups: STAGED,
          recallHistoryPattern: value,
        }),
      ).toThrow(message);
    }
  });

  it("are declared in the manifest config schema", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema: { properties: Record<string, Record<string, unknown>> } };
    expect(manifest.configSchema.properties.recallTagGroups).toMatchObject({ type: "array" });
    expect(manifest.configSchema.properties.recallHistoryPattern).toMatchObject({
      type: "string",
      maxLength: 500,
    });
  });
});

describe("recallFilterFor", () => {
  const base = { hindsightApiUrl: "http://h", allowInsecureHttp: true };
  it("returns the groups unless the query matches the history pattern", () => {
    const cfg = hindsightConfigSchema.parse({
      ...base,
      recallTagGroups: [{ not: { tags: ["kind:status"] } }],
      recallHistoryPattern: "\\bhistory\\b",
    });
    expect(recallFilterFor(cfg, "which host runs hindsight")).toEqual({
      tagGroups: [{ not: { tags: ["kind:status"] } }],
    });
    expect(recallFilterFor(cfg, "the HISTORY of the queue")).toEqual({});
    expect(recallFilterFor(hindsightConfigSchema.parse(base), "anything")).toEqual({});
  });
});

describe("recallTopK and recallMinScore", () => {
  const base = { hindsightApiUrl: "http://h", allowInsecureHttp: true };

  it("are off by default", () => {
    const cfg = hindsightConfigSchema.parse(base);
    expect(cfg.recallTopK).toBeUndefined();
    expect(cfg.recallMinScore).toBeUndefined();
  });

  it("accept a cap of 1 to 50 and a floor of 0 to 1", () => {
    const cfg = hindsightConfigSchema.parse({ ...base, recallTopK: 6, recallMinScore: 0.15 });
    expect(cfg.recallTopK).toBe(6);
    expect(cfg.recallMinScore).toBe(0.15);
    expect(hindsightConfigSchema.parse({ ...base, recallTopK: 50 }).recallTopK).toBe(50);
    expect(hindsightConfigSchema.parse({ ...base, recallMinScore: 0 }).recallMinScore).toBe(0);
    expect(hindsightConfigSchema.parse({ ...base, recallMinScore: 1 }).recallMinScore).toBe(1);
  });

  it("reject values out of range or of the wrong type", () => {
    for (const bad of [0, 51, 2.5, "5"]) {
      expect(() => hindsightConfigSchema.parse({ ...base, recallTopK: bad })).toThrow(
        /recallTopK must be an integer from 1 to 50/,
      );
    }
    for (const bad of [-0.1, 1.01, Number.NaN, "0.2"]) {
      expect(() => hindsightConfigSchema.parse({ ...base, recallMinScore: bad })).toThrow(
        /recallMinScore must be a number from 0 to 1/,
      );
    }
  });

  it("are declared in the manifest config schema with the same bounds and no default", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema: { properties: Record<string, Record<string, unknown>> } };
    const props = manifest.configSchema.properties;
    expect(props.recallTopK).toMatchObject({ type: "integer", minimum: 1, maximum: 50 });
    expect(props.recallMinScore).toMatchObject({ type: "number", minimum: 0, maximum: 1 });
    expect(props.recallTopK).not.toHaveProperty("default");
    expect(props.recallMinScore).not.toHaveProperty("default");
  });
});

describe("memoryPromptSection (Q6)", () => {
  const base = { hindsightApiUrl: "http://h", allowInsecureHttp: true };
  it("defaults to false, accepts a boolean and is in the manifest", () => {
    expect(hindsightConfigSchema.parse(base).memoryPromptSection).toBe(false);
    expect(
      hindsightConfigSchema.parse({ ...base, memoryPromptSection: true }).memoryPromptSection,
    ).toBe(true);
    expect(() => hindsightConfigSchema.parse({ ...base, memoryPromptSection: "yes" })).toThrow(
      /memoryPromptSection/,
    );
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { configSchema: { properties: Record<string, unknown> } };
    expect(manifest.configSchema.properties.memoryPromptSection).toMatchObject({
      type: "boolean",
      default: false,
    });
  });
});

const parseHistory = (recallHistoryPattern: string) =>
  hindsightConfigSchema.parse({
    hindsightApiUrl: "http://h",
    allowInsecureHttp: true,
    recallTagGroups: [{ tags: ["a"] }],
    recallHistoryPattern,
  });

/** The refusal message for `token` at 1-based `at`, as a RegExp. */
const refusal = (token: string, at: number, what: string) =>
  new RegExp(
    `recallHistoryPattern: "${token.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}" at character ${at} is ${what}`,
  );

const ANY_REFUSAL = /recallHistoryPattern: ".+" at character \d+ is .+; 0\.9\.0 accepts only/;

/** 16 alternatives of \w{n} in one capture group: a refused shape (capture group, quantifier). */
const wGroup = (n: number) => `(${Array.from({ length: 16 }, () => `\\w{${n}}`).join("|")})`;
const alternatives = (branches: string[]) => `(?:${branches.join("|")})`;
const a = (n: number) => Array.from({ length: n }, () => "a");

describe("recallHistoryPattern allowlist grammar (0.9.0)", () => {
  // Refused examples: every N1, N2 and N3 pattern from the 0.9.0 review, and slow shapes an
  // earlier quantifier-counting guard let through. The grammar refuses each at its first bad token.
  it("refuses every pattern from the review and the slow ones the denylist accepted", () => {
    const a60 = "a".repeat(60);
    const a200 = "a".repeat(200);
    const slow = [
      // N1
      `${"(a|aa)".repeat(14)}c`,
      `${"(a|aa)".repeat(18)}c`,
      `${"(a|aa)".repeat(22)}c`,
      `${"(a|aa)".repeat(26)}c`,
      `${"(|a)".repeat(60)}${"a".repeat(60)}`,
      `${"(a|b|ab)".repeat(28)}!`,
      `${"(?:(a)|(aa))".repeat(24)}c`,
      `${"(a|aa){1}".repeat(26)}c`,
      `${"(?:a|aa)".repeat(22)}c`,
      // N2
      "[^]*[^]*[^]*[^]*=",
      "([^]+[^])+x",
      "(?:[^]*[^])*x",
      "([]|[^]+[^])+x",
      // N3
      "a*a*b",
      "a+a+b",
      ".*.*=",
      "\\w*\\w*=",
      "(a)*(a)*b",
      "(\\w)*(\\w)*=",
      "(a*)(a*)\\1b",
      "(.*)(.*)\\1\\2x",
      "(\\w*)(\\w*)\\1\\2\\1\\2=",
      `(?:(?=${a60})a)*(?:(?=${a60})a)*b`,
      `(?:(?=${a200})a)*(?:(?=${a200})a)*b`,
      `(?:(?<=${a60})a)*(?:(?<=${a60})a)*b`,
      // Refused: two quantified capture groups, two 110-branch groups, nested optional captures
      `\\w{0,800}${wGroup(4)}${wGroup(4)}=`,
      `\\w{0,800}${wGroup(8)}${wGroup(8)}=`,
      `\\w{0,800}${wGroup(40)}${wGroup(40)}=`,
      `${alternatives(a(110))}${alternatives(a(110))}a*b`,
      `\\w{0,800}${"((((a?))))".repeat(8)}=`,
    ];
    for (const value of slow) {
      expect(value.length).toBeLessThanOrEqual(500);
      expect(() => parseHistory(value)).toThrow(ANY_REFUSAL);
    }
  });

  it("names the first token outside the grammar and where it is", () => {
    const cases: Array<[string, string, number, string]> = [
      ["a*a*b", "*", 2, "a quantifier"],
      ["ab+", "+", 3, "a quantifier"],
      ["colou?r", "?", 6, "a quantifier"],
      ["\\w{0,800}=", "{0,800}", 3, "a quantifier"],
      ["a{3}", "{3}", 2, "a quantifier"],
      ["(?:a|b)?", "?", 8, "a quantifier"],
      ["(?:a|b){2}", "{2}", 8, "a quantifier"],
      ["(a|aa)c", "(", 1, "a capture group"],
      ["x(?<n>a)", "(?<n>", 2, "a named capture group"],
      ["status(?!es)", "(?!", 7, "a lookahead"],
      ["(?=a)", "(?=", 1, "a lookahead"],
      ["(?<!no )history", "(?<!", 1, "a lookbehind"],
      ["(?<=the )timeline", "(?<=", 1, "a lookbehind"],
      ["[^]*=", "[^]", 1, "a character class"],
      ["x[a-z]", "[a-z]", 2, "a character class"],
      ["[]x", "[]", 1, "a character class"],
      ["(?:(a)|(aa))", "(", 4, "a capture group"],
      ["(?:a|(?:b|c))", "(?:", 6, "a nested group"],
      ["(?:a|aa)(?:a|aa)c", "(?:", 9, "a second group in one | alternative"],
      ["a.b", ".", 2, "the any-character dot"],
      ["(a)\\1", "(", 1, "a capture group"],
      ["a\\1", "\\1", 2, "a backreference"],
      ["a\\k<n>", "\\k", 2, "a backreference"],
      ["\\B", "\\B", 1, "an escape outside the allowlist"],
      ["a\\n", "\\n", 2, "an escape outside the allowlist"],
      ["\\u0041", "\\u", 1, "an escape outside the allowlist"],
      ["a}", "}", 2, "a literal brace"],
      ["a{", "{", 2, "a literal brace"],
      ["a]", "]", 2, "a literal bracket"],
    ];
    for (const [value, token, at, what] of cases) {
      expect(() => parseHistory(value)).toThrow(refusal(token, at, what));
    }
  });

  it("names a modifier group as one, not as a capture group, and refuses it", () => {
    const cases: Array<[string, string, number]> = [
      ["(?i:a)", "(?i:", 1],
      ["x(?-i:a)", "(?-i:", 2],
      ["(?im-s:history)", "(?im-s:", 1],
    ];
    for (const [value, token, at] of cases) {
      expect(() => parseHistory(value)).toThrow(refusal(token, at, "a modifier group"));
      expect(() => parseHistory(value)).not.toThrow(/capture group/);
    }
  });

  it("refuses a pattern that matches the empty string, since it would match every query", () => {
    for (const value of [
      "history|timeline|",
      "|history",
      "history||timeline",
      "(?:history|)",
      "(?:)",
      "^",
      "$",
      "^$",
      "status(?:|es)|",
    ]) {
      expect(new RegExp(value, "i").test("")).toBe(true);
      expect(() => parseHistory(value)).toThrow(
        /recallHistoryPattern matches the empty string, so it would match every query and turn recallTagGroups off/,
      );
    }
    // Patterns that need at least one character still load.
    for (const value of ["(?:)a", "history|timeline", "^status$", "(?:history|timeline)\\b"]) {
      expect(parseHistory(value).recallHistoryPattern?.source).toBe(value);
    }
  });

  it("accepts a realistic status pattern, and it matches in any case", () => {
    const cfg = parseHistory("\\b(?:waiting on|pending review|pipeline running)\\b");
    const test = (q: string) => cfg.recallHistoryPattern?.test(q);
    expect(test("still WAITING ON the reviewer?")).toBe(true);
    expect(test("is !70 pending review")).toBe(true);
    expect(test("Pipeline Running since noon")).toBe(true);
    expect(test("where does hindsight run?")).toBe(false);
    expect(test("pipeline runningx")).toBe(false);
  });

  it("accepts the README example and other patterns inside the grammar", () => {
    for (const value of [
      "\\b(?:history|timeline|status|progress|what happened|when did|so far|previous|earlier|changed|still)\\b",
      "^status$",
      "history|timeline|so far",
      "\\bv\\d\\.\\d\\b",
      "\\(draft\\)|\\[wip\\]|a\\|b|\\$\\^\\*\\+\\?\\{\\}\\.",
      "x(?:a|b)|y(?:c|d)\\s\\w",
      "(?:)a",
      "a-b_c,d:e=f!g'h\"i#j%k&l~m<n>o@p",
    ]) {
      expect(parseHistory(value).recallHistoryPattern?.source).toBe(value);
    }
  });

  it("keeps the 500-character cap", () => {
    expect(() => parseHistory("a".repeat(500))).not.toThrow();
    expect(() => parseHistory("a".repeat(501))).toThrow(
      /recallHistoryPattern must be at most 500 characters/,
    );
  });

  it("generates no code at runtime: no node:vm, eval or Function in the shipped sources", () => {
    const dir = new URL("./", import.meta.url);
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name === "test-helpers.ts") {
        continue;
      }
      const source = readFileSync(new URL(name, dir), "utf8");
      expect([name, /node:vm|\beval\(|new Function\(/.test(source)]).toEqual([name, false]);
    }
  });
});

/** mulberry32, as in retain-queue-model.test.ts: seeded, so a failure is reproducible. */
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// Atoms biased toward what the adversarial queries hold, so matches run long before they fail.
const ATOMS = ["a", "a", "a", "b", " ", "1", "\\w", "\\w", "\\d", "\\s", "\\b", "\\.", "^", "$"];

/** A random pattern inside the grammar, at most 500 characters. */
function randomPattern(next: () => number): string {
  const pick = <T>(list: T[]) => list[Math.floor(next() * list.length)]!;
  const atoms = (n: number) => Array.from({ length: n }, () => pick(ATOMS)).join("");
  const branchLen = 1 + Math.floor(next() * (next() < 0.3 ? 120 : 12));
  const branch = () => {
    const before = atoms(Math.floor(next() * branchLen));
    if (next() < 0.5) {
      return `${before}${atoms(1)}`;
    }
    const inner = Array.from({ length: 1 + Math.floor(next() * 40) }, () =>
      atoms(1 + Math.floor(next() * 6)),
    );
    return `${before}(?:${inner.join("|")})${atoms(Math.floor(next() * branchLen))}!`;
  };
  for (;;) {
    const value = Array.from({ length: 1 + Math.floor(next() * 8) }, branch).join("|");
    // A pattern that matches "" is refused at load, so the generator skips it.
    if (value.length <= 500 && !new RegExp(value, "i").test("")) {
      return value;
    }
  }
}

describe("recallHistoryPattern allowlist grammar: property", () => {
  const QUERIES = [
    "a".repeat(800),
    "a ".repeat(400),
    "a1".repeat(400),
    "ab".repeat(400),
    `${"a".repeat(799)}!`,
  ];

  it("400 random accepted patterns each run under 5 ms on 800-character adversarial queries", () => {
    const next = prng(0x090);
    let slowest = { ms: 0, pattern: "", query: 0 };
    for (let n = 0; n < 400; n++) {
      const value = randomPattern(next);
      const cfg = parseHistory(value);
      QUERIES.forEach((query, q) => {
        expect(query).toHaveLength(800);
        // Best of 3, so one GC pause on a busy runner does not fail the test.
        let best = Infinity;
        for (let r = 0; r < 3; r++) {
          const started = performance.now();
          recallFilterFor(cfg, query);
          best = Math.min(best, performance.now() - started);
        }
        if (best > slowest.ms) {
          slowest = { ms: best, pattern: value, query: q };
        }
      });
    }
    expect({ ...slowest, fast: slowest.ms < 5 }).toMatchObject({ fast: true });
  });
});
