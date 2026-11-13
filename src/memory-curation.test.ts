import { describe, expect, it } from "vitest";
import {
  type AdminIo,
  createAdminCommands,
  formatMemory,
  registerAdminCommands,
} from "./cli-admin.js";
import { HindsightClient, toMemoryDetail } from "./client.js";
import { hindsightConfigSchema } from "./config.js";
import { createFakeHindsight } from "./test-helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;

const ID = "a197d546-f7db-412c-a175-b3356713d39f";
const OBS = "0b5e0d2c-0000-4000-8000-000000000001";
const GONE = "00000000-0000-0000-0000-000000000000";
const unit = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  text: "Rule: never merge your own MR.",
  context: "chat",
  date: "2026-10-29T16:27:40Z",
  type: "world",
  mentioned_at: "2026-10-29T16:27:40Z",
  occurred_start: null,
  occurred_end: null,
  entities: ["GitLab", "MR"],
  document_id: "doc-1",
  tags: [],
  state: "valid",
  invalidation_reason: null,
  edited_at: null,
  consolidated_at: "2026-11-06T12:45:57Z",
  ...extra,
});
const path = (id: string, suffix = "") => `/v1/default/banks/main/memories/${id}${suffix}`;

function admin(
  params: { tty?: boolean; confirm?: boolean; memory?: Record<string, unknown> } = {},
) {
  const fake = createFakeHindsight({
    [`GET ${path(ID)}`]: () => ({ json: unit(ID, params.memory) }),
    [`GET ${path(OBS)}`]: () => ({ json: unit(OBS, { type: "observation" }) }),
    [`GET ${path(GONE)}`]: () => ({
      status: 404,
      json: { detail: `Memory unit '${GONE}' not found` },
    }),
    [`PATCH ${path(ID)}`]: () => ({ json: unit(ID) }),
    [`DELETE ${path(ID, "/observations")}`]: () => ({ json: { deleted_count: 3 } }),
  });
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const asked: string[] = [];
  const io: AdminIo = {
    log: (...a) => out.push(a.join(" ")),
    error: (...a) => err.push(a.join(" ")),
    exit: (c) => exits.push(c),
    isTTY: params.tty ?? true,
    confirm: async (q) => {
      asked.push(q);
      return params.confirm ?? false;
    },
  };
  const config = hindsightConfigSchema.parse({
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
    hindsightApiToken: "secret-token-value",
  });
  const commands = createAdminCommands({
    io: () => io,
    parseConfig: () => ({ config }),
    clientFor: (c) =>
      new HindsightClient({
        resolveEndpoint: () => ({ apiUrl: c.apiUrl, apiToken: c.apiToken }),
        fetch: fake.fetch,
      }),
  });
  const result = () => ({
    out: out.join("\n"),
    err: err.join("\n"),
    exit: exits.at(-1) ?? 0,
    asked,
    writes: fake.requests
      .filter((r) => r.method !== "GET")
      .map((r) => ({ call: `${r.method} ${new URL(r.url).pathname}`, body: r.body })),
  });
  return { commands, result };
}

describe("memory unit client", () => {
  it("parses the 1.2.1 memory unit and drops empty fields", () => {
    expect(toMemoryDetail(unit(ID))).toEqual({
      id: ID,
      text: "Rule: never merge your own MR.",
      type: "world",
      context: "chat",
      mentionedAt: "2026-10-29T16:27:40Z",
      documentId: "doc-1",
      tags: [],
      entities: ["GitLab", "MR"],
      state: "valid",
      consolidatedAt: "2026-11-06T12:45:57Z",
    });
    expect(toMemoryDetail({ id: ID })).toBeNull();
    expect(toMemoryDetail(null)).toBeNull();
  });

  it("sends only the fields set on PATCH and reads deleted_count", async () => {
    const fake = createFakeHindsight({
      [`PATCH ${path(ID)}`]: () => ({ json: {} }),
      [`DELETE ${path(ID, "/observations")}`]: () => ({ json: { deleted_count: 2 } }),
      [`GET ${path(GONE)}`]: () => ({ status: 404, json: { detail: "Not Found" } }),
    });
    const client = new HindsightClient({
      resolveEndpoint: () => ({ apiUrl: "http://hindsight.test" }),
      fetch: fake.fetch,
    });
    await client.updateMemory("main", ID, { state: "invalidated", reason: "wrong" });
    await client.updateMemory("main", ID, { text: "new" });
    expect(fake.requests.map((r) => r.body)).toEqual([
      { state: "invalidated", reason: "wrong" },
      { text: "new" },
    ]);
    expect(await client.clearMemoryObservations("main", ID)).toEqual({ deleted: 2 });
    // A route 404 is not "no such memory".
    await expect(client.getMemoryDetail("main", GONE)).rejects.toThrow("HTTP 404");
  });
});

describe("openclaw hindsight memory show", () => {
  it("prints the memory without the token, or JSON", async () => {
    const { commands, result } = admin();
    await commands.memoryShow(ID, {});
    const r = result();
    expect(r.out).toContain(`${ID}  [world]  state valid`);
    expect(r.out).toContain("text: Rule: never merge your own MR.");
    expect(r.out).toContain("document: doc-1");
    expect(r.out).toContain("entities: GitLab, MR");
    expect(r.out).not.toContain("secret-token-value");
    const json = admin();
    await json.commands.memoryShow(ID, { json: true });
    expect(JSON.parse(json.result().out).memory.id).toBe(ID);
  });

  it("fails on a missing memory or id", async () => {
    const { commands, result } = admin();
    await commands.memoryShow(GONE, {});
    expect(result().err).toContain(`no memory ${GONE} in bank main`);
    expect(result().exit).toBe(1);
    const empty = admin();
    await empty.commands.memoryShow(" ", {});
    expect(empty.result().exit).toBe(1);
  });
});

describe("openclaw hindsight memory curate", () => {
  it("needs exactly one action and a sane text", async () => {
    for (const opts of [
      {},
      { text: "a", restore: true },
      { text: "  " },
      { text: "x".repeat(8001) },
    ]) {
      const { commands, result } = admin();
      await commands.memoryCurate(ID, { ...opts, yes: true });
      expect(result().exit).toBe(1);
      expect(result().writes).toEqual([]);
    }
  });

  it("previews the change, asks, and PATCHes the new text after a yes", async () => {
    const declined = admin({ confirm: false });
    await declined.commands.memoryCurate(ID, { text: "Never merge your own MR; use a reviewer." });
    expect(declined.result().out).toContain("Replace the text with:");
    expect(declined.result().asked).toEqual([`Curate memory ${ID} in bank main? [y/N] `]);
    expect(declined.result().writes).toEqual([]);

    const ok = admin({ confirm: true });
    await ok.commands.memoryCurate(ID, { text: "Never merge your own MR." });
    expect(ok.result().writes).toEqual([
      { call: `PATCH ${path(ID)}`, body: { text: "Never merge your own MR." } },
    ]);
    expect(ok.result().out).toContain(`Curated memory ${ID}.`);
  });

  it("restores only an invalidated memory", async () => {
    const valid = admin({ confirm: true });
    await valid.commands.memoryCurate(ID, { restore: true });
    expect(valid.result().err).toContain("is not invalidated");
    expect(valid.result().writes).toEqual([]);

    const invalid = admin({
      tty: false,
      memory: { state: "invalidated", invalidation_reason: "x" },
    });
    await invalid.commands.memoryCurate(ID, { restore: true, yes: true });
    expect(invalid.result().writes).toEqual([
      { call: `PATCH ${path(ID)}`, body: { state: "valid" } },
    ]);
    expect(invalid.result().out).toContain("invalidated because: x");
  });

  it("clears observations with --clear-observations and honors --dry-run", async () => {
    const dry = admin();
    await dry.commands.memoryCurate(ID, { clearObservations: true, dryRun: true });
    expect(dry.result().writes).toEqual([]);
    expect(dry.result().out).toContain("Dry run: nothing was changed.");

    const ok = admin({ tty: false });
    await ok.commands.memoryCurate(ID, { clearObservations: true, yes: true });
    expect(ok.result().writes).toEqual([
      { call: `DELETE ${path(ID, "/observations")}`, body: undefined },
    ]);
    expect(ok.result().out).toContain("Deleted 3 observation(s)");
  });

  it("refuses observations and missing memories before any write", async () => {
    const obs = admin({ confirm: true });
    await obs.commands.memoryCurate(OBS, { text: "x" });
    expect(obs.result().err).toContain("observations are derived");
    const gone = admin({ confirm: true });
    await gone.commands.memoryInvalidate(GONE, {});
    expect(gone.result().err).toContain(`no memory ${GONE}`);
    expect([...obs.result().writes, ...gone.result().writes]).toEqual([]);
  });

  it("needs --yes outside a terminal", async () => {
    const { commands, result } = admin({ tty: false });
    await commands.memoryCurate(ID, { text: "x" });
    expect(result().err).toContain("pass --yes");
    expect(result().writes).toEqual([]);
  });
});

describe("openclaw hindsight memory invalidate", () => {
  it("invalidates with a reason after a yes and says when it already is", async () => {
    const ok = admin({ confirm: true });
    await ok.commands.memoryInvalidate(ID, { reason: " wrong rule " });
    expect(ok.result().writes).toEqual([
      { call: `PATCH ${path(ID)}`, body: { state: "invalidated", reason: "wrong rule" } },
    ]);
    expect(ok.result().out).toContain("memory curate --restore reverts it");

    const already = admin({ confirm: true, memory: { state: "invalidated" } });
    await already.commands.memoryInvalidate(ID, {});
    expect(already.result().out).toContain("already invalidated");
    expect(already.result().writes).toEqual([]);

    const long = admin({ confirm: true });
    await long.commands.memoryInvalidate(ID, { reason: "r".repeat(2001) });
    expect(long.result().exit).toBe(1);
  });
});

describe("memory command registration and formatting", () => {
  it("registers memory show, curate and invalidate", () => {
    const made: string[] = [];
    const node = (prefix: string): Record<string, AnyFn> => {
      const self: Record<string, AnyFn> = {
        command: (name: string) => {
          made.push(`${prefix} ${name}`.trim());
          return node(`${prefix} ${name.split(" ")[0]}`.trim());
        },
        description: () => self,
        option: () => self,
        requiredOption: () => self,
        action: () => self,
      };
      return self;
    };
    registerAdminCommands(node("") as never, {
      io: () => ({}) as AdminIo,
      parseConfig: () => ({ error: "x" }),
      clientFor: () => ({}) as HindsightClient,
    });
    expect(made.filter((m) => m.startsWith("memory"))).toEqual([
      "memory",
      "memory show <id>",
      "memory curate <id>",
      "memory invalidate <id>",
    ]);
  });

  it("formats occurred ranges, edits and tags", () => {
    const lines = formatMemory({
      id: "m",
      text: "a\n b",
      tags: ["t1", "t2"],
      entities: [],
      occurredStart: "2026-01-01",
      occurredEnd: "2026-01-02",
      editedAt: "2026-02-01",
    });
    expect(lines).toEqual([
      "m  [?]  state valid",
      "  text: a b",
      "  occurred 2026-01-01 to 2026-01-02, edited 2026-02-01",
      "  tags: t1, t2",
    ]);
  });
});
