import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CONFIG_KEYS } from "./config.js";

const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
const section = changelog.split(/^## 0\.10\.0 /m)[1]?.split(/^## /m)[0] ?? "";
const part = (name: string) => section.split(`### ${name}\n`)[1]?.split(/^### /m)[0] ?? "";
const oneLine = (text: string) => text.replace(/\s+/g, " ");

/** The config keys 0.9.0 shipped (its openclaw.plugin.json). */
const KEYS_090 = [
  "hindsightApiUrl",
  "hindsightApiToken",
  "memoryMode",
  "allowInsecureHttp",
  "autoRecall",
  "autoRetain",
  "recallBudget",
  "recallTypes",
  "preferObservations",
  "recallPromptPreamble",
  "retainMission",
  "retainContext",
  "retainTags",
  "excludeProviders",
  "skipOperationalSessions",
  "ignoreSessionPatterns",
  "recallOnlySessionPatterns",
  "retainQueueEnabled",
  "retainQueueMaxItems",
  "retainQueueMaxAgeMs",
  "recallCacheTtlMs",
  "recallFollowupMaxWords",
  "recallQueryShaping",
  "recallTopK",
  "recallMinScore",
  "recallTagGroups",
  "recallHistoryPattern",
  "recallTimeoutMs",
  "memoryPromptSection",
  "promptDirectives",
  "privateTranscriptRecall",
  "knowledgeReadTools",
  "listToolsWithoutAudience",
  "agentBankMap",
  "agents",
  "recallEarlyStart",
  "recallStaleOnTimeout",
  "recallSkipEntities",
  "slotMode",
  "activeMemoryYield",
  "corpusSupplement",
  "corpusSupplementSessionPatterns",
  "memoryFileSync",
  "memoryFileSyncAgents",
  "memoryFileSyncIntervalMs",
];

describe("CHANGELOG 0.10.0 (release prep)", () => {
  it("has a dated 0.10.0 heading", () => {
    expect(changelog).toMatch(/^## 0\.10\.0 \(\d{4}-\d{2}-\d{2}\)$/m);
  });

  // 0.10.0 adds no config key. If one is added before the tag, this fails until the upgrade
  // notes name it with its default (and this list moves to the new key set).
  it("adds no config key over 0.9.0, and the upgrade notes say so", () => {
    expect([...CONFIG_KEYS].toSorted()).toEqual([...KEYS_090].toSorted());
    const notes = oneLine(part("Upgrade notes"));
    expect(notes).toContain("No new config keys");
    expect(notes).toContain("no changed defaults");
  });

  it("lists the fixes and the measured levers that were not shipped", () => {
    const text = oneLine(section);
    for (const needle of [
      "`<.hindsight_memories>`",
      "compat-nightly",
      "`npm run manifest`",
      "`recallBudget: low`",
      "docs/recall-query-shaping.md",
    ]) {
      expect({ needle, found: text.includes(needle) }).toEqual({ needle, found: true });
    }
  });
});
