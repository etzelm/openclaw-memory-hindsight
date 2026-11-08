import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECALL_PROMPT_PREAMBLE,
  hasUnresolvedToken,
  hindsightConfigSchema,
  isPlainHttpRemote,
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
