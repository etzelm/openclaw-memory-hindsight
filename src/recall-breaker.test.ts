import { describe, expect, it } from "vitest";
import { HindsightHttpError } from "./client.js";
import {
  countsAsRecallOutage,
  RECALL_BREAKER_COOLDOWN_MS,
  RECALL_BREAKER_THRESHOLD,
  RecallBreaker,
} from "./recall-breaker.js";

function clock(start = 1_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const timeout = () => new DOMException("timed out", "TimeoutError");

describe("countsAsRecallOutage", () => {
  it("counts timeouts, network failures and HTTP 5xx", () => {
    expect(countsAsRecallOutage(timeout())).toBe(true);
    expect(countsAsRecallOutage(new TypeError("fetch failed"))).toBe(true);
    expect(countsAsRecallOutage(new HindsightHttpError("x", 502))).toBe(true);
    expect(countsAsRecallOutage(new HindsightHttpError("x", 500))).toBe(true);
  });

  it("never counts an answer about the request, a missing bank or a host abort", () => {
    expect(countsAsRecallOutage(new HindsightHttpError("x", 404, true))).toBe(false);
    for (const status of [400, 401, 403, 404, 422, 429]) {
      expect(countsAsRecallOutage(new HindsightHttpError("x", status))).toBe(false);
    }
    expect(countsAsRecallOutage(new DOMException("aborted", "AbortError"))).toBe(false);
    expect(countsAsRecallOutage(new Error("other"))).toBe(false);
  });
});

describe("RecallBreaker", () => {
  it("uses 3 failures and a 60 s cool-down by default", () => {
    expect(RECALL_BREAKER_THRESHOLD).toBe(3);
    expect(RECALL_BREAKER_COOLDOWN_MS).toBe(60_000);
  });

  it("opens after the threshold of consecutive outages, not before", () => {
    const c = clock();
    const breaker = new RecallBreaker({ now: c.now });
    for (let i = 0; i < RECALL_BREAKER_THRESHOLD - 1; i++) {
      expect(breaker.admit()).toBe("allow");
      expect(breaker.record(timeout())).toBe("none");
    }
    expect(breaker.state()).toBe("closed");
    expect(breaker.admit()).toBe("allow");
    expect(breaker.record(timeout())).toBe("opened");
    expect(breaker.state()).toBe("open");
    expect(breaker.admit()).toBe("skip");
  });

  it("a success or a non-outage answer resets the count", () => {
    const breaker = new RecallBreaker({ now: clock().now });
    breaker.record(timeout());
    breaker.record(timeout());
    breaker.record(undefined);
    breaker.record(timeout());
    breaker.record(timeout());
    breaker.record(new HindsightHttpError("x", 401));
    breaker.record(timeout());
    breaker.record(timeout());
    expect(breaker.state()).toBe("closed");
  });

  it("skips for the cool-down, then lets exactly one probe through", () => {
    const c = clock();
    const breaker = new RecallBreaker({ now: c.now, threshold: 1, cooldownMs: 1000 });
    breaker.record(timeout());
    c.advance(999);
    expect(breaker.admit()).toBe("skip");
    c.advance(1);
    expect(breaker.admit()).toBe("probe");
    // While the probe is in flight, every other turn still skips.
    expect(breaker.admit()).toBe("skip");
    expect(breaker.state()).toBe("open");
  });

  it("a failed probe reopens for a full cool-down", () => {
    const c = clock();
    const breaker = new RecallBreaker({ now: c.now, threshold: 1, cooldownMs: 1000 });
    breaker.record(timeout());
    c.advance(1000);
    expect(breaker.admit()).toBe("probe");
    expect(breaker.record(new TypeError("fetch failed"), true)).toBe("reopened");
    c.advance(999);
    expect(breaker.admit()).toBe("skip");
    c.advance(1);
    expect(breaker.admit()).toBe("probe");
  });

  it("a probe that gets any answer closes the breaker", () => {
    for (const outcome of [undefined, new HindsightHttpError("x", 404, true)]) {
      const c = clock();
      const breaker = new RecallBreaker({ now: c.now, threshold: 1, cooldownMs: 1000 });
      breaker.record(timeout());
      c.advance(1000);
      expect(breaker.admit()).toBe("probe");
      expect(breaker.record(outcome, true)).toBe("closed");
      expect(breaker.state()).toBe("closed");
      expect(breaker.admit()).toBe("allow");
    }
  });

  it("a late failure from a request admitted before the breaker opened does not extend it", () => {
    const c = clock();
    const breaker = new RecallBreaker({ now: c.now, threshold: 2, cooldownMs: 1000 });
    breaker.admit();
    breaker.admit();
    breaker.admit();
    breaker.record(timeout());
    expect(breaker.record(timeout())).toBe("opened");
    c.advance(500);
    expect(breaker.record(timeout())).toBe("none");
    c.advance(500);
    expect(breaker.admit()).toBe("probe");
    // A late failure that is not the probe does not count as the probe's answer.
    expect(breaker.record(timeout())).toBe("none");
    expect(breaker.record(undefined, true)).toBe("closed");
  });

  it("reset closes it", () => {
    const breaker = new RecallBreaker({ now: clock().now, threshold: 1 });
    breaker.record(timeout());
    breaker.reset();
    expect(breaker.state()).toBe("closed");
    expect(breaker.admit()).toBe("allow");
  });
});
