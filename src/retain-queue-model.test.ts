import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Model-based tests for the retain queue: seeded random runs of retains, replay, saves, crashes
 * (a fresh queue loads the file), disk-full windows, failed renames and torn writes followed by a
 * crash, checked against invariants after every step. No property-test library: a seeded
 * generator keeps runs reproducible. A failure names the seed and the operations that led to it.
 *
 * More runs: HS_QUEUE_FUZZ_RUNS=2000 npx vitest run src/retain-queue-model.test.ts
 */

// Fault injection below the queue: every write path of retain-queue.ts goes through these.
const fault = vi.hoisted(() => ({
  /** Every write fails with ENOSPC (disk full). */
  enospc: false,
  /** renameSync fails (a rewrite cannot replace the file). */
  failRename: false,
  /** The next append or write stores only half its text, then the process "dies". */
  tornNext: false,
  /** After a torn write: every write fails until the test reloads (a new process). */
  dead: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- vi.mock factories cannot use module scope
  const ioError = (code: string) => Object.assign(new Error(`${code}: simulated`), { code });
  const gate = () => {
    if (fault.dead) {
      throw ioError("EIO");
    }
    if (fault.enospc) {
      throw ioError("ENOSPC");
    }
  };
  return {
    ...real,
    // Durability is not under test here, and fsync makes thousands of steps slow.
    fsyncSync: () => undefined,
    appendFileSync: (...args: Parameters<typeof real.appendFileSync>) => {
      gate();
      if (fault.tornNext) {
        fault.tornNext = false;
        const text = String(args[1]);
        real.appendFileSync(args[0], text.slice(0, Math.max(1, Math.floor(text.length / 2))));
        fault.dead = true;
        throw ioError("EIO");
      }
      return real.appendFileSync(...args);
    },
    writeSync: (fd: number, data: string) => {
      gate();
      if (fault.tornNext) {
        fault.tornNext = false;
        real.writeSync(fd, data.slice(0, Math.floor(data.length / 2)));
        fault.dead = true;
        throw ioError("EIO");
      }
      return real.writeSync(fd, data);
    },
    renameSync: (...args: Parameters<typeof real.renameSync>) => {
      gate();
      if (fault.failRename) {
        throw ioError("EIO");
      }
      return real.renameSync(...args);
    },
    rmSync: (...args: Parameters<typeof real.rmSync>) => {
      if (fault.dead) {
        throw ioError("EIO");
      }
      return real.rmSync(...args);
    },
  };
});

const { RetainQueue, RetainQueueRunner } = await import("./retain-queue.js");
const { HindsightHttpError } = await import("./client.js");
type QueuedRetain = import("./retain-queue.js").QueuedRetain;
type Queue = InstanceType<typeof RetainQueue>;

const FUZZ_RUNS = Number(process.env.HS_QUEUE_FUZZ_RUNS) || 0;
// About 20 ms per run on a laptop; leave room for slow CI runners.
const TIMEOUT_MS = Math.max(30_000, FUZZ_RUNS * 200);
const BANKS = ["alpha", "beta"] as const;
const DOCS = 4;
const STALE_WARNING = "could not mark an out-of-date queued retain";

/** mulberry32: small, fast, good enough to pick operations. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const keyOf = (e: { bankId: string; documentId: string }) => `${e.bankId}/${e.documentId}`;
/** Content carries its own version: "<bank>/<doc>#<version>|<padding>". */
const versionOf = (e: QueuedRetain) => Number(/#(\d+)\|/.exec(e.item.content)![1]);

type Limits = { maxItems: number; maxAgeMs: number };
type ModelOptions = {
  limits: Limits;
  maxBytes: number;
  steps: number;
  faults: boolean;
  /** Content padding: [min, max] bytes, plus the chance of an item over maxBytes. */
  pad: [number, number];
  tooLarge: number;
  /** Accepted retains must survive (off when the bounds may drop items). */
  checkNoLoss: boolean;
};

/** Everything a run tracks besides the queue itself. */
class World {
  readonly trace: string[] = [];
  readonly warnings: string[] = [];
  /** Last version handed to the queue or sent live, per document. */
  readonly issued = new Map<string, number>();
  /** Lowest version that may still reach the server: the newest one accepted or sent live. */
  readonly floor = new Map<string, number>();
  /** Newest version the server holds. */
  readonly server = new Map<string, number>();
  /** Accepted into the queue and not yet delivered. */
  readonly pending = new Map<string, number>();
  readonly regressions: string[] = [];
  /** What the run reached, so a test can assert its generator exercised each fault. */
  readonly stats = {
    reloads: 0,
    torn: 0,
    diskFull: 0,
    renameFail: 0,
    refused: 0,
    lost: 0,
    deliveries: 0,
  };
  clock = 1_000_000;

  deliver(key: string, version: number, how: string) {
    const last = this.server.get(key) ?? 0;
    if (version < last) {
      this.regressions.push(`${key}: server had v${last}, ${how} sent v${version}`);
    }
    this.server.set(key, Math.max(last, version));
    this.stats.deliveries += 1;
    if ((this.pending.get(key) ?? 0) <= version) {
      this.pending.delete(key);
    }
  }

  accept(key: string, version: number) {
    this.floor.set(key, Math.max(this.floor.get(key) ?? 0, version));
    this.pending.set(key, version);
  }

  /** Regressions are allowed only after the queue warned it could not write a tombstone. */
  unexplainedRegressions(): string[] {
    return this.warnings.some((w) => w.includes(STALE_WARNING)) ? [] : this.regressions;
  }

  fail(seed: number, message: string): string {
    return `seed ${seed}: ${message}\n  last steps:\n    ${this.trace.slice(-25).join("\n    ")}`;
  }
}

/** An assertion with a lazily built message (the trace is long). */
function must(ok: boolean, message: () => string): void {
  if (!ok) {
    throw new Error(message());
  }
}

function mustNotRegress(world: World, seed: number): void {
  const regressions = world.unexplainedRegressions();
  must(regressions.length === 0, () =>
    world.fail(seed, `server saw an older copy: ${regressions.join("; ")}`),
  );
}

function healFaults() {
  fault.enospc = false;
  fault.failRename = false;
  fault.tornNext = false;
  fault.dead = false;
}

function checkQueue(world: World, seed: number, q: Queue, filePath: string, opts: ModelOptions) {
  const keys = q.list().map(keyOf);
  must(new Set(keys).size === keys.length, () =>
    world.fail(seed, `duplicate documents: ${keys.join(", ")}`),
  );
  must(q.size() <= opts.limits.maxItems, () => world.fail(seed, "maxItems exceeded"));
  if (existsSync(filePath) && statSync(filePath).size > opts.maxBytes) {
    // Known and accepted (0.8.0 lane A finding): when a rewrite fails, markStale() appends a
    // tombstone without the byte check, because dropping it could let a restart replay an
    // out-of-date copy. So only tombstone lines may take the file past the bound.
    const queueBytes = readFileSync(filePath, "utf8")
      .split("\n")
      .filter((line) => line && !line.startsWith('{"tombstone":'))
      .reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0);
    must(queueBytes <= opts.maxBytes, () => world.fail(seed, "queue lines over the byte bound"));
  }
}

/** The queue's entries in order (test-only view of its private state). */
function entriesOf(q: Queue): QueuedRetain[] {
  return (q as unknown as { stored: Array<{ entry: QueuedRetain }> }).stored.map((s) => s.entry);
}

/** After a load: no queued copy older than what the server must keep, and nothing accepted lost. */
function checkAfterLoad(world: World, seed: number, q: Queue, opts: ModelOptions) {
  const allowed = world.warnings.some((w) => w.includes(STALE_WARNING));
  for (const e of entriesOf(q)) {
    const key = keyOf(e);
    const floor = world.floor.get(key) ?? 0;
    if (versionOf(e) < floor && !allowed) {
      throw new Error(
        world.fail(seed, `${key}: v${versionOf(e)} queued after a load, but v${floor} is newer`),
      );
    }
  }
  if (opts.checkNoLoss) {
    const inQueue = new Map(entriesOf(q).map((e) => [keyOf(e), versionOf(e)]));
    for (const [key, version] of world.pending) {
      if ((world.server.get(key) ?? 0) < version && (inQueue.get(key) ?? 0) < version) {
        throw new Error(world.fail(seed, `${key}: accepted v${version} lost after a load`));
      }
    }
  }
}

function makeQueue(world: World, filePath: string, opts: ModelOptions): Queue {
  const q = new RetainQueue({
    filePath,
    limits: () => opts.limits,
    logger: {
      warn: (m: string) => world.warnings.push(m),
      info: () => undefined,
      debug: () => undefined,
    },
    now: () => world.clock,
    maxBytes: opts.maxBytes,
  });
  q.load();
  return q;
}

function newEntry(world: World, rnd: () => number, opts: ModelOptions) {
  const bankId = BANKS[Math.floor(rnd() * BANKS.length)]!;
  const documentId = `doc-${Math.floor(rnd() * DOCS)}`;
  const key = `${bankId}/${documentId}`;
  const version = (world.issued.get(key) ?? 0) + 1;
  world.issued.set(key, version);
  const [lo, hi] = opts.pad;
  const pad = rnd() < opts.tooLarge ? opts.maxBytes + 1 : lo + Math.floor(rnd() * (hi - lo + 1));
  const entry = {
    bankId,
    documentId,
    item: { content: `${key}#${version}|${"x".repeat(pad)}`, document_id: documentId },
  };
  return { entry, key, version };
}

/**
 * One retain through the service's protocol (src/service.ts retainOrQueue): queue behind a bank
 * that has items, else send live; a failed live write is queued; a successful live write
 * supersedes an unsaved delivered copy. The live write fails when `down` is true.
 */
function retain(world: World, q: Queue, rnd: () => number, opts: ModelOptions, down: boolean) {
  const { entry, key, version } = newEntry(world, rnd, opts);
  world.stats.diskFull += fault.enospc ? 1 : 0;
  world.stats.renameFail += fault.failRename ? 1 : 0;
  const tryEnqueue = () => {
    try {
      return q.enqueue(entry);
    } catch {
      return false;
    }
  };
  if (q.hasBank(entry.bankId)) {
    if (tryEnqueue()) {
      world.accept(key, version);
      world.trace.push(`retain ${key} v${version}: queued behind its bank`);
      return;
    }
    // Refused: the service sends it live without waiting for the bank's queue.
    world.stats.refused += 1;
    world.deliver(key, version, "a live write after a refused enqueue");
    world.floor.set(key, version);
    q.supersede(entry);
    world.trace.push(`retain ${key} v${version}: refused by the queue, sent live`);
    return;
  }
  if (!down) {
    world.deliver(key, version, "a live write");
    world.floor.set(key, version);
    q.supersede(entry);
    world.trace.push(`retain ${key} v${version}: sent live`);
    return;
  }
  if (tryEnqueue()) {
    world.accept(key, version);
    world.trace.push(`retain ${key} v${version}: live failed, queued`);
  } else {
    world.stats.lost += 1;
    world.trace.push(`retain ${key} v${version}: live failed, not queued (lost)`);
  }
}

/** One replay delivery, as RetainQueueRunner does it: send, remove without writing, save later. */
function replayOne(world: World, q: Queue, rnd: () => number) {
  const e = q.peek();
  if (!e) {
    return;
  }
  world.deliver(keyOf(e), versionOf(e), "replay");
  q.remove(e, { persist: false });
  world.trace.push(`replay ${keyOf(e)} v${versionOf(e)}`);
  if (rnd() < 0.3) {
    try {
      q.save();
      world.trace.push("save");
    } catch {
      world.trace.push("save failed");
    }
  }
}

function runModel(seed: number, opts: ModelOptions): World["stats"] {
  const rnd = prng(seed);
  const dir = mkdtempSync(join(tmpdir(), "hs-queue-model-"));
  const filePath = join(dir, "hindsight-native", "retain-queue.jsonl");
  const world = new World();
  healFaults();
  try {
    let q = makeQueue(world, filePath, opts);
    const reload = (why: string) => {
      fault.dead = false;
      fault.tornNext = false;
      q = makeQueue(world, filePath, opts);
      world.stats.reloads += 1;
      world.trace.push(`reload (${why})`);
      checkAfterLoad(world, seed, q, opts);
    };
    for (let i = 0; i < opts.steps; i++) {
      const r = rnd();
      if (r < 0.4) {
        retain(world, q, rnd, opts, rnd() < 0.6);
      } else if (r < 0.62) {
        replayOne(world, q, rnd);
      } else if (r < 0.7) {
        try {
          q.save();
          world.trace.push("save");
        } catch {
          world.trace.push("save failed");
        }
      } else if (r < 0.78) {
        reload("crash");
      } else if (opts.faults && r < 0.84) {
        fault.enospc = !fault.enospc;
        world.trace.push(`disk full ${fault.enospc ? "on" : "off"}`);
      } else if (opts.faults && r < 0.88) {
        fault.failRename = !fault.failRename;
        world.trace.push(`rename failures ${fault.failRename ? "on" : "off"}`);
      } else if (opts.faults && r < 0.93) {
        // A torn write, then the process dies: the caller never learns the outcome.
        const enospc = fault.enospc;
        fault.enospc = false;
        fault.tornNext = true;
        const { entry, key, version } = newEntry(world, rnd, opts);
        try {
          q.enqueue(entry);
        } catch {
          // the process is gone
        }
        world.stats.torn += 1;
        world.trace.push(`torn write while queueing ${key} v${version}, then crash`);
        fault.enospc = enospc;
        reload("torn write");
      } else {
        // Expiry drops items by design, so the no-loss runs keep the clock well inside the bound.
        world.clock += Math.floor(rnd() * opts.limits.maxAgeMs * (opts.checkNoLoss ? 0.001 : 0.5));
        world.trace.push("clock advances");
      }
      checkQueue(world, seed, q, filePath, opts);
    }
    // Heal, restart, drain everything: the server must end on the newest version it was owed.
    healFaults();
    reload("final restart");
    for (let e = q.peek(); e; e = q.peek()) {
      world.deliver(keyOf(e), versionOf(e), "final replay");
      q.remove(e, { persist: false });
    }
    q.save();
    must(!existsSync(filePath), () => world.fail(seed, "file left after draining"));
    mustNotRegress(world, seed);
    if (opts.checkNoLoss) {
      for (const [key, floor] of world.floor) {
        must((world.server.get(key) ?? 0) >= floor, () =>
          world.fail(seed, `${key} ended below v${floor}`),
        );
      }
    }
    return world.stats;
  } finally {
    healFaults();
    rmSync(dir, { recursive: true, force: true });
  }
}

const seeds = (n: number, base: number) => Array.from({ length: n }, (_, i) => base + i);

type Stats = World["stats"];
const addStats = (total: Stats, run: Stats) => {
  for (const key of Object.keys(total) as Array<keyof Stats>) {
    total[key] += run[key];
  }
};
const emptyStats = (): Stats => new World().stats;

beforeEach(() => healFaults());
afterEach(() => healFaults());

describe("retain queue model", () => {
  it(
    "keeps every accepted retain and never replays an older copy (no faults)",
    () => {
      const total = emptyStats();
      for (const seed of seeds(FUZZ_RUNS || 60, 1)) {
        addStats(
          total,
          runModel(seed, {
            limits: { maxItems: 1000, maxAgeMs: 1e12 },
            maxBytes: 1 << 22,
            steps: 60,
            faults: false,
            pad: [0, 200],
            tooLarge: 0,
            checkNoLoss: true,
          }),
        );
      }
      expect(total.reloads).toBeGreaterThan(0);
      expect(total.deliveries).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    "survives disk-full windows, failed renames and torn writes followed by a crash",
    () => {
      const total = emptyStats();
      for (const seed of seeds(FUZZ_RUNS || 80, 1001)) {
        addStats(
          total,
          runModel(seed, {
            limits: { maxItems: 1000, maxAgeMs: 1e12 },
            maxBytes: 1 << 22,
            steps: 60,
            faults: true,
            pad: [0, 200],
            tooLarge: 0,
            checkNoLoss: true,
          }),
        );
      }
      expect(total.torn).toBeGreaterThan(0);
      expect(total.diskFull).toBeGreaterThan(0);
      expect(total.renameFail).toBeGreaterThan(0);
      expect(total.refused).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );

  it(
    "holds the item, age and byte bounds, refuses oversized items and stays monotonic",
    () => {
      const total = emptyStats();
      for (const seed of seeds(FUZZ_RUNS || 80, 5001)) {
        addStats(
          total,
          runModel(seed, {
            limits: { maxItems: 5, maxAgeMs: 60_000 },
            maxBytes: 4096,
            steps: 60,
            faults: true,
            pad: [0, 900],
            tooLarge: 0.05,
            checkNoLoss: false,
          }),
        );
      }
      expect(total.refused).toBeGreaterThan(0);
      expect(total.reloads).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});

type Send = { entry: QueuedRetain; settle: (ok: boolean) => void };

async function runConcurrent(seed: number): Promise<World["stats"]> {
  const rnd = prng(seed);
  const dir = mkdtempSync(join(tmpdir(), "hs-queue-runner-"));
  const filePath = join(dir, "hindsight-native", "retain-queue.jsonl");
  const world = new World();
  const opts: ModelOptions = {
    limits: { maxItems: 1000, maxAgeMs: 1e12 },
    maxBytes: 1 << 22,
    steps: 50,
    faults: false,
    pad: [0, 50],
    tooLarge: 0,
    checkNoLoss: true,
  };
  const sends: Send[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const makeRunner = (queue: Queue) =>
    new RetainQueueRunner(queue, {
      send: (entry) =>
        new Promise<void>((resolve, reject) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          sends.push({
            entry,
            settle: (ok) => {
              inFlight -= 1;
              if (ok) {
                world.deliver(keyOf(entry), versionOf(entry), "replay");
                resolve();
              } else {
                reject(new HindsightHttpError("Hindsight retain failed: HTTP 503", 503));
              }
            },
          });
        }),
      logger: { warn: (m: string) => world.warnings.push(m) },
      // Timers never fire inside a run; passes start only from flush() below.
      baseDelayMs: 1e9,
    });
  const settle = async (ok: boolean) => {
    const send = sends.splice(Math.floor(rnd() * sends.length), 1)[0];
    send?.settle(ok);
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
  };
  try {
    let q = makeQueue(world, filePath, opts);
    let runner = makeRunner(q);
    for (let i = 0; i < opts.steps; i++) {
      const r = rnd();
      if (r < 0.45) {
        retain(world, q, rnd, opts, rnd() < 0.7);
        // The service starts a pass after a queued retain and after a live one with a backlog.
        void runner.flush();
      } else if (r < 0.6) {
        // Several callers asking for a pass at once must still share one.
        void runner.flush();
        void runner.flush();
        void runner.flush();
      } else if (r < 0.85) {
        await settle(rnd() < 0.8);
      } else {
        // Crash with sends in flight: some reached the server, none were removed.
        runner.stop();
        for (const send of sends.splice(0)) {
          if (rnd() < 0.5) {
            world.deliver(keyOf(send.entry), versionOf(send.entry), "in-flight at crash");
          }
          inFlight -= 1;
        }
        q = makeQueue(world, filePath, opts);
        checkAfterLoad(world, seed, q, opts);
        runner = makeRunner(q);
        world.stats.reloads += 1;
        world.trace.push("crash with sends in flight");
      }
      for (let k = 0; k < 5; k++) {
        await Promise.resolve();
      }
      must(maxInFlight <= 1, () => world.fail(seed, "two replay sends in flight"));
      checkQueue(world, seed, q, filePath, opts);
    }
    // Drain: every send succeeds until the queue is empty.
    for (let guard = 0; guard < 500 && (q.size() > 0 || sends.length > 0); guard++) {
      void runner.flush();
      for (let k = 0; k < 5; k++) {
        await Promise.resolve();
      }
      await settle(true);
    }
    runner.stop();
    must(q.size() === 0, () => world.fail(seed, "queue not drained"));
    mustNotRegress(world, seed);
    for (const [key, floor] of world.floor) {
      must((world.server.get(key) ?? 0) >= floor, () =>
        world.fail(seed, `${key} ended below v${floor}`),
      );
    }
    return world.stats;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("retain queue runner under concurrent replays", () => {
  it(
    "runs one send at a time, never sends an older copy last, and drains",
    async () => {
      const total = emptyStats();
      for (const seed of seeds(FUZZ_RUNS || 60, 9001)) {
        addStats(total, await runConcurrent(seed));
      }
      expect(total.reloads).toBeGreaterThan(0);
      expect(total.deliveries).toBeGreaterThan(0);
    },
    TIMEOUT_MS,
  );
});
