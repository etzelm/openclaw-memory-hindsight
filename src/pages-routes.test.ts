import { describe, expect, it } from "vitest";
import {
  HindsightClient,
  HindsightHttpError,
  isExplicitPageMissingBody,
  isRouteMissingBody,
} from "./client.js";
import { createFakeHindsight } from "./test-helpers.js";

const ROUTE_404 = () => ({ status: 404, json: { detail: "Not Found" } });

function clientFor(routes: Parameters<typeof createFakeHindsight>[0]) {
  const fake = createFakeHindsight(routes);
  const client = new HindsightClient({
    resolveEndpoint: () => ({ apiUrl: "http://hindsight.test", apiToken: "t" }),
    fetch: fake.fetch,
  });
  const paths = () => fake.requests.map((r) => new URL(r.url).pathname + new URL(r.url).search);
  return { client, paths };
}

describe("page reads on /pages/* (Hindsight 1.2.1)", () => {
  it("reads tree, search and page from /pages/* without touching /knowledge-base/*", async () => {
    const { client, paths } = clientFor({
      "GET /v1/default/banks/dev/pages/tree": () => ({
        json: { roots: [{ id: "kp-1", kind: "page", name: "P" }] },
      }),
      "GET /v1/default/banks/dev/pages/search": () => ({
        json: { results: [{ id: "kp-1", name: "P", snippet: "s" }] },
      }),
      "GET /v1/default/banks/dev/pages/kp-1": () => ({ json: { name: "P", markdown: "# P" } }),
    });
    expect(await client.getKnowledgeBaseTree("dev")).toHaveLength(1);
    expect(await client.searchKnowledgeBase("dev", "q", { limit: 3 })).toHaveLength(1);
    expect(await client.getKnowledgePage("dev", "kp-1")).toEqual({
      id: "kp-1",
      name: "P",
      markdown: "# P",
    });
    expect(paths()).toEqual([
      "/v1/default/banks/dev/pages/tree",
      "/v1/default/banks/dev/pages/search?q=q&limit=3",
      "/v1/default/banks/dev/pages/kp-1",
    ]);
  });

  it("returns null for 1.2.1's `Page '<id>' not found` without a fallback request", async () => {
    const { client, paths } = clientFor({
      "GET /v1/default/banks/dev/pages/kp-x": () => ({
        status: 404,
        json: { detail: "Page 'kp-x' not found" },
      }),
    });
    expect(await client.getKnowledgePage("dev", "kp-x")).toBeNull();
    expect(paths()).toEqual(["/v1/default/banks/dev/pages/kp-x"]);
  });

  it("does not fall back on an explicit missing bank", async () => {
    const { client, paths } = clientFor({
      "GET /v1/default/banks/nobank/pages/tree": () => ({
        status: 404,
        json: { detail: "Bank 'nobank' not found" },
      }),
    });
    const error = await client.getKnowledgeBaseTree("nobank").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HindsightHttpError);
    expect((error as HindsightHttpError).bankMissingExplicit).toBe(true);
    expect((error as HindsightHttpError).routeMissing).toBe(false);
    expect(paths()).toEqual(["/v1/default/banks/nobank/pages/tree"]);
  });

  it("does not fall back on a 404 with another detail or an empty body", async () => {
    const { client, paths } = clientFor({
      "GET /v1/default/banks/dev/pages/search": () => ({
        status: 404,
        json: { detail: "Something else" },
      }),
    });
    await expect(client.searchKnowledgeBase("dev", "q")).rejects.toThrow("HTTP 404");
    // An empty body (the fake's default 404) keeps meaning "missing bank", not "missing route".
    await expect(client.getKnowledgeBaseTree("dev")).rejects.toThrow("HTTP 404");
    expect(paths()).toEqual([
      "/v1/default/banks/dev/pages/search?q=q",
      "/v1/default/banks/dev/pages/tree",
    ]);
  });
});

describe("fallback to /knowledge-base/* on older servers", () => {
  it("falls back once on a route 404 and then reads the old routes directly", async () => {
    const { client, paths } = clientFor({
      "GET /v1/default/banks/dev/pages/tree": ROUTE_404,
      "GET /v1/default/banks/dev/pages/search": ROUTE_404,
      "GET /v1/default/banks/dev/pages/kp-1": ROUTE_404,
      "GET /v1/default/banks/dev/knowledge-base/tree": () => ({
        json: { roots: [{ id: "kp-1", kind: "page", name: "P" }] },
      }),
      "GET /v1/default/banks/dev/knowledge-base/search": () => ({
        json: { results: [{ id: "kp-1", name: "P", snippet: "s" }] },
      }),
      "GET /v1/default/banks/dev/knowledge-base/pages/kp-1": () => ({
        json: { name: "P", markdown: "# P" },
      }),
    });
    expect(await client.getKnowledgeBaseTree("dev")).toHaveLength(1);
    expect(await client.searchKnowledgeBase("dev", "a b", { limit: 2 })).toHaveLength(1);
    expect((await client.getKnowledgePage("dev", "kp-1"))?.markdown).toBe("# P");
    expect(paths()).toEqual([
      "/v1/default/banks/dev/pages/tree",
      "/v1/default/banks/dev/knowledge-base/tree",
      "/v1/default/banks/dev/knowledge-base/search?q=a+b&limit=2",
      "/v1/default/banks/dev/knowledge-base/pages/kp-1",
    ]);
  });

  it("falls back for a page read and keeps the old `Knowledge page` 404 as null", async () => {
    const { client, paths } = clientFor({
      "GET /v1/default/banks/dev/pages/kp-x": ROUTE_404,
      "GET /v1/default/banks/dev/knowledge-base/pages/kp-x": () => ({
        status: 404,
        json: { detail: "Knowledge page 'kp-x' not found" },
      }),
    });
    expect(await client.getKnowledgePage("dev", "kp-x")).toBeNull();
    expect(paths()).toEqual([
      "/v1/default/banks/dev/pages/kp-x",
      "/v1/default/banks/dev/knowledge-base/pages/kp-x",
    ]);
  });

  it("keeps an error from the old route loud", async () => {
    const { client } = clientFor({
      "GET /v1/default/banks/dev/pages/tree": ROUTE_404,
      "GET /v1/default/banks/dev/knowledge-base/tree": () => ({ status: 500, json: {} }),
    });
    await expect(client.getKnowledgeBaseTree("dev")).rejects.toThrow("HTTP 500");
  });
});

describe("404 body classification", () => {
  it("treats only the bare `Not Found` detail as a missing route", () => {
    expect(isRouteMissingBody('{"detail":"Not Found"}')).toBe(true);
    expect(isRouteMissingBody('{"detail":" not found "}')).toBe(true);
    expect(isRouteMissingBody("")).toBe(false);
    expect(isRouteMissingBody("<html>Not Found</html>")).toBe(false);
    expect(isRouteMissingBody('{"detail":"Bank \'x\' not found"}')).toBe(false);
    expect(isRouteMissingBody('{"detail":"Page \'x\' not found"}')).toBe(false);
    expect(isRouteMissingBody("null")).toBe(false);
  });

  it("reads both the 1.2.1 and the older missing-page detail", () => {
    expect(isExplicitPageMissingBody('{"detail":"Page \'kp-1\' not found"}')).toBe(true);
    expect(isExplicitPageMissingBody('{"detail":"Knowledge page \'kp-1\' not found"}')).toBe(true);
    expect(isExplicitPageMissingBody('{"detail":"Not Found"}')).toBe(false);
    expect(isExplicitPageMissingBody('{"detail":"Bank \'x\' not found"}')).toBe(false);
  });
});
