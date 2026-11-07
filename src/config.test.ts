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
    const cfg = hindsightConfigSchema.parse({ hindsightApiUrl: "http://studio:8888/" });
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
      hindsightConfigSchema.parse({ hindsightApiUrl: "http://h", llmApiKey: "x" }),
    ).toThrow(/unknown keys: llmApiKey/);
    expect(() =>
      hindsightConfigSchema.parse({ hindsightApiUrl: "http://h", memoryMode: "files" }),
    ).toThrow(/memoryMode/);
    expect(() =>
      hindsightConfigSchema.parse({ hindsightApiUrl: "http://h", recallTypes: ["opinion"] }),
    ).toThrow(/recallTypes/);
  });

  it("keeps a resolved token and ignores an unresolved SecretRef object", () => {
    expect(
      hindsightConfigSchema.parse({ hindsightApiUrl: "http://h", hindsightApiToken: " t0k " })
        .apiToken,
    ).toBe("t0k");
    expect(
      hindsightConfigSchema.parse({
        hindsightApiUrl: "http://h",
        hindsightApiToken: { source: "file", provider: "p", id: "x" },
      }).apiToken,
    ).toBeUndefined();
  });

  it("rejects an api url with userinfo, a query string or a fragment", () => {
    expect(() => hindsightConfigSchema.parse({ hindsightApiUrl: "http://user:pw@h:8888" })).toThrow(
      /must not contain credentials/,
    );
    expect(() => hindsightConfigSchema.parse({ hindsightApiUrl: "http://user@h" })).toThrow(
      /credentials/,
    );
    expect(() => hindsightConfigSchema.parse({ hindsightApiUrl: "http://h?token=x" })).toThrow(
      /query string or fragment/,
    );
    expect(() => hindsightConfigSchema.parse({ hindsightApiUrl: "http://h#frag" })).toThrow(
      /query string or fragment/,
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

  it("parses the live third-party config subset and rejects dropped options", () => {
    const cfg = hindsightConfigSchema.parse({
      hindsightApiUrl: "http://hindsight.example:8888",
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
      hindsightConfigSchema.parse({ hindsightApiUrl: "http://h", recallInjectionPosition: "user" }),
    ).toThrow(/unknown keys: recallInjectionPosition/);
  });
});

describe("agentBankMap", () => {
  it("parses the vendor-compatible map and rejects bad entries", () => {
    const base = { hindsightApiUrl: "http://h" };
    expect(hindsightConfigSchema.parse(base).agentBankMap).toEqual({});
    expect(
      hindsightConfigSchema.parse({ ...base, agentBankMap: { " WB-Dev ": " wb " } }).agentBankMap,
    ).toEqual({ "wb-dev": "wb" });
    expect(() => hindsightConfigSchema.parse({ ...base, agentBankMap: ["wb"] })).toThrow(
      /agentBankMap/,
    );
    expect(() => hindsightConfigSchema.parse({ ...base, agentBankMap: { dev: "" } })).toThrow(
      /agentBankMap/,
    );
  });
});
