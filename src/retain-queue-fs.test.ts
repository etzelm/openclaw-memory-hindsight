import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// chmod failures cannot be produced with file modes when tests run as root, so inject them.
const fsState = vi.hoisted(() => ({ failChmod: false }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    chmodSync: (...args: Parameters<typeof real.chmodSync>) => {
      if (fsState.failChmod) {
        throw Object.assign(new Error("EPERM: operation not permitted, chmod"), { code: "EPERM" });
      }
      return real.chmodSync(...args);
    },
  };
});

const { RetainQueue, retainQueuePath } = await import("./retain-queue.js");

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "hs-queue-fs-"));
});
afterEach(() => {
  fsState.failChmod = false;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("RetainQueue with a failing chmod", () => {
  it("keeps an appended item when chmod fails after the append", () => {
    const file = retainQueuePath(stateDir);
    const queue = new RetainQueue({
      filePath: file,
      limits: () => ({ maxItems: 10, maxAgeMs: 60_000 }),
      logger: {},
    });
    queue.load();
    queue.enqueue({ bankId: "dev", documentId: "a", item: { content: "a", document_id: "a" } });
    fsState.failChmod = true;
    expect(
      queue.enqueue({ bankId: "dev", documentId: "b", item: { content: "b", document_id: "b" } }),
    ).toBe(true);
    const inFile = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => (JSON.parse(line) as { documentId: string }).documentId);
    expect(queue.list().map((e) => e.documentId)).toEqual(inFile);
    expect(inFile).toEqual(["a", "b"]);
  });
});
