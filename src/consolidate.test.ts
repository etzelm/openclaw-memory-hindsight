import { describe, expect, it } from "vitest";
import {
  type AdminIo,
  CONSOLIDATE_POLL_MS,
  createAdminCommands,
  formatOperation,
  registerAdminCommands,
} from "./cli-admin.js";
import { HindsightClient } from "./client.js";
import { hindsightConfigSchema } from "./config.js";
import { createFakeHindsight } from "./test-helpers.js";

// oxlint-disable-next-line typescript/no-explicit-any -- test doubles accept any host call shape
type AnyFn = (...args: any[]) => any;

const OP = "op-1";
const CONSOLIDATE = "POST /v1/default/banks/main/consolidate";
const STATUS = `GET /v1/default/banks/main/operations/${OP}`;

function harness(statuses: Array<Record<string, unknown>>, extra: Record<string, AnyFn> = {}) {
  let poll = 0;
  const fake = createFakeHindsight({
    [CONSOLIDATE]: () => ({ json: { operation_id: OP, deduplicated: false } }),
    [STATUS]: () => ({
      json: { operation_id: OP, ...statuses[Math.min(poll++, statuses.length - 1)] },
    }),
    ...extra,
  });
  const out: string[] = [];
  const err: string[] = [];
  const exits: number[] = [];
  const slept: number[] = [];
  const io: AdminIo = {
    log: (...a) => out.push(a.join(" ")),
    error: (...a) => err.push(a.join(" ")),
    exit: (c) => exits.push(c),
    isTTY: false,
    confirm: async () => false,
  };
  const config = hindsightConfigSchema.parse({
    hindsightApiUrl: "http://hindsight.test",
    allowInsecureHttp: true,
    hindsightApiToken: "secret-token-value",
  });
  const commands = createAdminCommands({
    io: () => io,
    sleep: async (ms) => {
      slept.push(ms);
    },
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
    slept,
    calls: fake.requests.map((r) => `${r.method} ${new URL(r.url).pathname}`),
    bodies: fake.requests.map((r) => r.body),
  });
  return { commands, result };
}

describe("openclaw hindsight consolidate", () => {
  it("queues consolidation with an empty body and returns without --wait", async () => {
    const { commands, result } = harness([]);
    await commands.consolidate({});
    const r = result();
    expect(r.calls).toEqual([CONSOLIDATE]);
    expect(r.bodies).toEqual([{}]);
    expect(r.out).toBe(`Bank main: consolidation queued, operation ${OP}`);
    expect(r.exit).toBe(0);
  });

  it("says when Hindsight reused a pending consolidation", async () => {
    const { commands, result } = harness([], {
      [CONSOLIDATE]: () => ({ json: { operation_id: OP, deduplicated: true } }),
    });
    await commands.consolidate({ bank: "main" });
    expect(result().out).toContain("consolidation already queued");
  });

  it("--wait polls until completed, printing each new status once", async () => {
    const { commands, result } = harness([
      { status: "pending" },
      { status: "pending" },
      {
        status: "processing",
        progress: { stage: "processing_batch", at: "t", processed: 1, total: 4 },
      },
      {
        status: "completed",
        progress: { stage: "done", at: "t", detail: { observations_created: 7 } },
      },
    ]);
    await commands.consolidate({ wait: true });
    const r = result();
    expect(r.out.split("\n")).toEqual([
      `Bank main: consolidation queued, operation ${OP}`,
      "pending",
      "processing  (processing_batch 1/4)",
      "completed  (done)  observations_created 7",
    ]);
    expect(r.slept).toEqual([CONSOLIDATE_POLL_MS, CONSOLIDATE_POLL_MS, CONSOLIDATE_POLL_MS]);
    expect(r.exit).toBe(0);
  });

  it("--wait exits 1 on a failed or cancelled operation", async () => {
    for (const status of ["failed", "cancelled", "not_found"]) {
      const { commands, result } = harness([{ status, error_message: "llm down" }]);
      await commands.consolidate({ wait: true });
      expect(result().out).toContain(`${status}  error: llm down`);
      expect(result().exit).toBe(1);
    }
  });

  it("--wait gives up after --timeout and says the job keeps running", async () => {
    const { commands, result } = harness([{ status: "processing" }]);
    const realNow = Date.now;
    // Every clock read moves time 1 s, so the 3 s deadline passes after a few polls.
    let now = 0;
    Date.now = () => (now += 1000);
    try {
      await commands.consolidate({ wait: true, timeout: "3" });
    } finally {
      Date.now = realNow;
    }
    expect(result().err).toContain("still processing after 3 s; it keeps running on the server");
    expect(result().exit).toBe(1);
  });

  it("rejects a bad --timeout before any request", async () => {
    for (const timeout of ["0", "1.5", "x", "3601"]) {
      const { commands, result } = harness([]);
      await commands.consolidate({ wait: true, timeout });
      expect(result().exit).toBe(1);
      expect(result().calls).toEqual([]);
    }
  });

  it("fails loudly when the request or a poll fails, never printing the token", async () => {
    const down = harness([], { [CONSOLIDATE]: () => ({ status: 503, json: {} }) });
    await down.commands.consolidate({});
    expect(down.result().err).toContain("HTTP 503");
    expect(down.result().exit).toBe(1);
    const pollFail = harness([], { [STATUS]: () => ({ status: 500, json: {} }) });
    await pollFail.commands.consolidate({ wait: true });
    expect(pollFail.result().err).toContain("could not read the operation");
    expect(`${down.result().err}${pollFail.result().err}`).not.toContain("secret-token-value");
    const noId = harness([], { [CONSOLIDATE]: () => ({ json: {} }) });
    await noId.commands.consolidate({});
    expect(noId.result().err).toContain("no operation id");
  });

  it("registers consolidate on the root command", () => {
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
    expect(made).toContain("consolidate");
  });

  it("formats a bare status", () => {
    expect(formatOperation({ id: "x", status: "pending" })).toBe("pending");
    expect(formatOperation({ id: "x", status: "processing", progress: { processed: 2 } })).toBe(
      "processing  2",
    );
  });
});
