import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HindsightClient } from "./client.js";
import { createFakeHindsight, type RecordedRequest } from "./test-helpers.js";

/**
 * Drift guard on the client side: every request the client makes must match a route, parameters
 * and body fields in the recorded Hindsight contract (scripts/fixtures/hindsight-api-contract.json,
 * from the 1.2.1 OpenAPI document; `node scripts/api-contract.mjs check <url>` compares a live
 * server with it). A new field sent here and not recorded there fails, which forces a re-recording
 * against a server that accepts it.
 */

type Shape = {
  type?: string;
  nullable?: boolean;
  anyOf?: Shape[];
  items?: Shape;
  properties?: Record<string, Shape>;
  required?: string[];
  ref?: string;
};
type Operation = { params: Record<string, Shape>; request: Shape | null; response: Shape | null };
const contract = JSON.parse(
  readFileSync(new URL("../scripts/fixtures/hindsight-api-contract.json", import.meta.url), "utf8"),
) as { hindsight: string; operations: Record<string, Operation> };

/** The recorded operation for a request URL, by matching each template segment. */
function operationFor(request: RecordedRequest): [string, Operation] {
  const url = new URL(request.url);
  const segments = url.pathname.split("/");
  const found = Object.entries(contract.operations).find(([key]) => {
    const [method, template] = key.split(" ");
    const parts = template!.split("/");
    return (
      method === request.method &&
      parts.length === segments.length &&
      parts.every((p, i) => /^\{.+\}$/.test(p) || p === segments[i])
    );
  });
  if (!found) {
    throw new Error(`no recorded route for ${request.method} ${url.pathname}`);
  }
  return found;
}

/** Every field path in a body that the recorded request shape does not know. */
function unknownFields(value: unknown, shape: Shape | null | undefined, path: string): string[] {
  if (!shape || shape.ref || value === null || typeof value !== "object") {
    return [];
  }
  if (Array.isArray(value)) {
    return shape.items
      ? value.flatMap((v, i) => unknownFields(v, shape.items, `${path}[${i}]`))
      : [];
  }
  if (!shape.properties) {
    return [];
  }
  return Object.entries(value).flatMap(([key, v]) => {
    const field = shape.properties![key];
    return field ? unknownFields(v, field, `${path}.${key}`) : [`${path}.${key}`];
  });
}

function everyRequest() {
  const fake = createFakeHindsight({
    "POST /v1/default/banks/dev/memories": () => ({ json: { success: true } }),
    "POST /v1/default/banks/dev/memories/recall": () => ({ json: { results: [] } }),
    "POST /v1/default/banks/dev/reflect": () => ({ json: { text: "" } }),
    "GET /v1/default/banks/dev/memories/m1": () => ({ json: { id: "m1", text: "x" } }),
    "PUT /v1/default/banks/dev": () => ({ json: {} }),
    "GET /v1/default/banks/dev/pages/tree": () => ({ json: { roots: [] } }),
    "GET /v1/default/banks/dev/pages/search": () => ({ json: { results: [] } }),
    "GET /v1/default/banks/dev/pages/p1": () => ({ json: { name: "p", markdown: "m" } }),
    // Bank "old" plays a server without /pages/*: the client falls back to /knowledge-base/*.
    "GET /v1/default/banks/old/pages/tree": () => ({ status: 404, json: { detail: "Not Found" } }),
    "GET /v1/default/banks/old/knowledge-base/tree": () => ({ json: { roots: [] } }),
    "GET /v1/default/banks/old/knowledge-base/search": () => ({ json: { results: [] } }),
    "GET /v1/default/banks/old/knowledge-base/pages/p1": () => ({
      json: { name: "p", markdown: "m" },
    }),
    "GET /v1/default/banks/dev/directives": () => ({
      json: { items: [], total: 0, limit: 100, offset: 0 },
    }),
    "POST /v1/default/banks/dev/directives": () => ({
      json: { id: "d1", bank_id: "dev", name: "n", content: "c" },
    }),
    "GET /v1/default/banks/dev/directives/d1": () => ({
      json: { id: "d1", bank_id: "dev", name: "n", content: "c" },
    }),
    "DELETE /v1/default/banks/dev/directives/d1": () => ({ json: { success: true } }),
    "PATCH /v1/default/banks/dev/memories/m1": () => ({ json: {} }),
    "DELETE /v1/default/banks/dev/memories/m1/observations": () => ({
      json: { deleted_count: 0 },
    }),
    "POST /v1/default/banks/dev/consolidate": () => ({ json: { operation_id: "o1" } }),
    "GET /v1/default/banks/dev/operations/o1": () => ({
      json: { operation_id: "o1", status: "completed" },
    }),
    "GET /health": () => ({ json: {} }),
    "GET /version": () => ({ json: { api_version: "1.2.1", features: {} } }),
    "GET /v1/default/banks": () => ({ json: { banks: [] } }),
    "GET /v1/default/banks/dev/documents": () => ({
      json: { items: [], total: 0, limit: 10, offset: 0 },
    }),
    "DELETE /v1/default/banks/dev/documents/d1": () => ({
      json: { success: true, message: "", document_id: "d1", memory_units_deleted: 0 },
    }),
  });
  const client = new HindsightClient({
    resolveEndpoint: () => ({ apiUrl: "http://hindsight.test", apiToken: "t" }),
    fetch: fake.fetch,
  });
  return { fake, client };
}

describe("Hindsight API contract (recorded from 1.2.1)", () => {
  it("covers every request the client makes, with every option set", async () => {
    const { fake, client } = everyRequest();
    await client.retain("dev", {
      content: "c",
      context: "x",
      metadata: { a: "b" },
      document_id: "d",
      tags: ["t"],
      timestamp: "2026-11-11T00:00:00Z",
      update_mode: "replace",
    });
    // Every recall option the client has, so a new option fails here until it is recorded.
    // tagGroups is cast in: the client sends it once recallTagGroups lands, and ignores it before.
    await client.recall("dev", "q", {
      budget: "mid",
      maxTokens: 1024,
      types: ["world"],
      preferObservations: true,
      minScores: { final: 0.1 },
      ...({ tagGroups: [{ not: { tags: ["kind:status"] } }] } as object),
      // hindsight_recall since/until (0.9.0); cast in like tagGroups above.
      ...({
        temporalWindow: { start: "2026-11-01T00:00:00.000Z", end: "2026-11-07T23:59:59.999Z" },
      } as object),
    });
    await client.reflect("dev", "q", { budget: "low" });
    await client.getMemory("dev", "m1");
    await client.applyBankDefaults("dev", { retainMission: "m" });
    await client.getKnowledgeBaseTree("dev");
    await client.searchKnowledgeBase("dev", "q", { limit: 5 });
    await client.getKnowledgePage("dev", "p1");
    // The fallback routes: once a route 404 is seen, this client reads /knowledge-base/*.
    await client.getKnowledgeBaseTree("old");
    await client.searchKnowledgeBase("old", "q", { limit: 5 });
    await client.getKnowledgePage("old", "p1");
    await client.listDirectives("dev", { activeOnly: true });
    await client.createDirective("dev", { name: "n", content: "c", priority: 1, tags: ["t"] });
    await client.getDirective("dev", "d1");
    await client.deleteDirective("dev", "d1");
    await client.getMemoryDetail("dev", "m1");
    await client.updateMemory("dev", "m1", { text: "t", state: "invalidated", reason: "r" });
    await client.clearMemoryObservations("dev", "m1");
    await client.consolidate("dev");
    await client.operationStatus("dev", "o1");
    await client.healthy();
    // The openclaw hindsight CLI's requests.
    await client.version();
    await client.listBanks();
    await client.listDocuments("dev", { q: "openclaw:", limit: 10, offset: 0 });
    await client.deleteDocument("dev", "d1");

    const seen = new Set<string>();
    const problems: string[] = [];
    for (const request of fake.requests) {
      const [key, op] = operationFor(request);
      seen.add(key);
      for (const name of new URL(request.url).searchParams.keys()) {
        if (!op.params[`query:${name}`]) {
          problems.push(`${key}: query parameter ${name} not recorded`);
        }
      }
      if (request.body === undefined) {
        continue;
      }
      if (!op.request) {
        problems.push(`${key}: body sent, none recorded`);
        continue;
      }
      problems.push(...unknownFields(request.body, op.request, "body").map((f) => `${key}: ${f}`));
      for (const field of op.request.required ?? []) {
        if (!(field in (request.body as Record<string, unknown>))) {
          problems.push(`${key}: required ${field} not sent`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect([...seen].toSorted()).toEqual(Object.keys(contract.operations).toSorted());
  });

  it("records every response field the client reads", () => {
    const fields = (key: string, path: string[]) => {
      let shape: Shape | null | undefined = contract.operations[key]?.response;
      for (const part of path) {
        shape = part === "[]" ? shape?.items : shape?.properties?.[part];
      }
      return shape;
    };
    const reads: Array<[string, string[]]> = [
      ["POST /v1/default/banks/{bank_id}/memories/recall", ["results", "[]", "id"]],
      ["POST /v1/default/banks/{bank_id}/memories/recall", ["results", "[]", "text"]],
      ["POST /v1/default/banks/{bank_id}/memories/recall", ["results", "[]", "type"]],
      ["POST /v1/default/banks/{bank_id}/memories/recall", ["results", "[]", "scores", "final"]],
      ["POST /v1/default/banks/{bank_id}/reflect", ["text"]],
      ["GET /v1/default/banks/{bank_id}/pages/tree", ["roots", "[]", "children"]],
      ["GET /v1/default/banks/{bank_id}/pages/tree", ["roots", "[]", "kind"]],
      ["GET /v1/default/banks/{bank_id}/pages/search", ["results", "[]", "snippet"]],
      ["GET /v1/default/banks/{bank_id}/pages/{page_id}", ["markdown"]],
      ["GET /v1/default/banks/{bank_id}/knowledge-base/tree", ["roots", "[]", "children"]],
      ["GET /v1/default/banks/{bank_id}/knowledge-base/tree", ["roots", "[]", "kind"]],
      ["GET /v1/default/banks/{bank_id}/knowledge-base/search", ["results", "[]", "snippet"]],
      ["GET /v1/default/banks/{bank_id}/knowledge-base/pages/{page_id}", ["markdown"]],
      ["GET /v1/default/banks/{bank_id}/directives", ["items", "[]", "content"]],
      ["GET /v1/default/banks/{bank_id}/directives", ["items", "[]", "is_active"]],
      ["GET /v1/default/banks/{bank_id}/directives", ["items", "[]", "tags"]],
      ["POST /v1/default/banks/{bank_id}/directives", ["id"]],
      ["GET /v1/default/banks/{bank_id}/directives/{directive_id}", ["content"]],
      ["DELETE /v1/default/banks/{bank_id}/memories/{memory_id}/observations", ["deleted_count"]],
      ["POST /v1/default/banks/{bank_id}/consolidate", ["operation_id"]],
      ["GET /v1/default/banks/{bank_id}/operations/{operation_id}", ["status"]],
      ["GET /v1/default/banks/{bank_id}/operations/{operation_id}", ["progress", "processed"]],
      ["GET /version", ["api_version"]],
      ["GET /v1/default/banks/{bank_id}/documents", ["items", "[]", "id"]],
      ["GET /v1/default/banks/{bank_id}/documents", ["items", "[]", "memory_unit_count"]],
      ["DELETE /v1/default/banks/{bank_id}/documents/{document_id}", ["memory_units_deleted"]],
    ];
    const missing = reads
      .filter(([key, path]) => !fields(key, path))
      .map(([k, p]) => `${k} ${p.join(".")}`);
    expect(missing).toEqual([]);
    expect(contract.hindsight).toBe("1.2.1");
  });
});

describe("Hindsight API contract: 0.9.0 request fields (0.9.0 review P2-7)", () => {
  it("records include.entities on recall and fact_types on reflect", async () => {
    const { fake, client } = everyRequest();
    await client.recall("dev", "q", { budget: "mid", skipEntities: true });
    await client.reflect("dev", "q", { budget: "low", types: ["world"] });
    const problems: string[] = [];
    for (const request of fake.requests) {
      const [key, op] = operationFor(request);
      problems.push(...unknownFields(request.body, op.request, "body").map((f) => `${key}: ${f}`));
    }
    expect(fake.requests.map((r) => r.body)).toEqual([
      { query: "q", budget: "mid", include: { entities: null } },
      { query: "q", budget: "low", fact_types: ["world"] },
    ]);
    expect(problems).toEqual([]);
    const recall = contract.operations["POST /v1/default/banks/{bank_id}/memories/recall"]!;
    const entities = recall.request?.properties?.include?.properties?.entities;
    // Sent as null to turn entities off, so the recorded field must allow null.
    expect(entities?.anyOf?.some((s) => s.type === "null") || entities?.nullable).toBe(true);
    const reflect = contract.operations["POST /v1/default/banks/{bank_id}/reflect"]!;
    expect(reflect.request?.properties?.fact_types).toBeTruthy();
  });
});
