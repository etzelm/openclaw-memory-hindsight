#!/usr/bin/env node
// Hindsight API contract: the slice of the server's OpenAPI document this plugin depends on (the
// routes the client calls, their parameters, request bodies and success responses).
//
//   node scripts/api-contract.mjs extract <openapi.json | URL>
//       Print the slice as JSON (how scripts/fixtures/hindsight-api-contract.json was recorded).
//   node scripts/api-contract.mjs check <openapi.json | URL> [--fixture PATH]
//       Compare the server's slice with the recorded one. Exit 1 when something the plugin relies
//       on is gone or changed type (a route, a parameter, a request or response field, or a new
//       required request field); additions are listed and exit 0. Exit 2 on a usage or fetch error.
//
// No dependencies; node 22 or later. A URL is fetched without credentials (Hindsight serves
// /openapi.json without auth); nothing is sent but the GET.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE = join(HERE, "fixtures", "hindsight-api-contract.json");

/**
 * Every route src/client.ts calls (the plugin and the openclaw hindsight CLI), with the request fields it sends and the response fields it
 * reads ("a[].b" is field b of each item of array a). The contract keeps only those fields, plus
 * the full list of required request fields, so drift in fields the plugin never touches is noise
 * it does not report.
 */
export const OPERATIONS = [
  {
    method: "POST",
    path: "/v1/default/banks/{bank_id}/memories",
    sends: [
      "async",
      "items[].content",
      "items[].context",
      "items[].metadata",
      "items[].document_id",
      "items[].tags",
      "items[].timestamp",
      "items[].update_mode",
    ],
    reads: [],
  },
  {
    method: "POST",
    path: "/v1/default/banks/{bank_id}/memories/recall",
    sends: [
      "query",
      "budget",
      "max_tokens",
      "types",
      "prefer_observations",
      "min_scores.final",
      "tag_groups",
      "temporal_window.start",
      "temporal_window.end",
      "include.entities",
    ],
    reads: [
      "results[].id",
      "results[].text",
      "results[].type",
      "results[].mentioned_at",
      "results[].occurred_start",
      "results[].occurred_end",
      "results[].document_id",
      "results[].scores.final",
    ],
  },
  {
    method: "POST",
    path: "/v1/default/banks/{bank_id}/reflect",
    sends: ["query", "budget", "fact_types"],
    reads: ["text"],
  },
  // Hindsight 1.2.1 declares no response schema here; the client checks `text` itself.
  { method: "GET", path: "/v1/default/banks/{bank_id}/memories/{memory_id}", sends: [], reads: [] },
  { method: "PUT", path: "/v1/default/banks/{bank_id}", sends: ["retain_mission"], reads: [] },
  // Page reads use /pages/*; the deprecated /knowledge-base/* routes are the fallback for servers
  // that answer the new route with a route 404.
  {
    method: "GET",
    path: "/v1/default/banks/{bank_id}/pages/tree",
    sends: [],
    reads: ["roots[].id", "roots[].kind", "roots[].name", "roots[].is_stale", "roots[].children"],
  },
  {
    method: "GET",
    path: "/v1/default/banks/{bank_id}/pages/search",
    sends: [],
    reads: ["results[].id", "results[].name", "results[].snippet"],
  },
  {
    method: "GET",
    path: "/v1/default/banks/{bank_id}/pages/{page_id}",
    sends: [],
    reads: ["name", "markdown"],
  },
  {
    method: "GET",
    path: "/v1/default/banks/{bank_id}/knowledge-base/tree",
    sends: [],
    reads: ["roots[].id", "roots[].kind", "roots[].name", "roots[].is_stale", "roots[].children"],
  },
  {
    method: "GET",
    path: "/v1/default/banks/{bank_id}/knowledge-base/search",
    sends: [],
    reads: ["results[].id", "results[].name", "results[].snippet"],
  },
  {
    method: "GET",
    path: "/v1/default/banks/{bank_id}/knowledge-base/pages/{page_id}",
    sends: [],
    reads: ["name", "markdown"],
  },
  // promptDirectives and openclaw hindsight directives.
  {
    method: "GET",
    path: "/v1/default/banks/{bank_id}/directives",
    sends: [],
    reads: [
      "items[].id",
      "items[].name",
      "items[].content",
      "items[].priority",
      "items[].is_active",
      "items[].tags",
    ],
  },
  {
    method: "POST",
    path: "/v1/default/banks/{bank_id}/directives",
    sends: ["name", "content", "priority", "tags"],
    reads: ["id", "name", "content", "priority", "is_active", "tags"],
  },
  {
    method: "GET",
    path: "/v1/default/banks/{bank_id}/directives/{directive_id}",
    sends: [],
    reads: ["id", "name", "content", "priority", "is_active", "tags"],
  },
  {
    method: "DELETE",
    path: "/v1/default/banks/{bank_id}/directives/{directive_id}",
    sends: [],
    reads: [],
  },
  // openclaw hindsight memory curate | invalidate. 1.2.1 declares no PATCH response schema.
  {
    method: "PATCH",
    path: "/v1/default/banks/{bank_id}/memories/{memory_id}",
    sends: ["text", "state", "reason"],
    reads: [],
  },
  {
    method: "DELETE",
    path: "/v1/default/banks/{bank_id}/memories/{memory_id}/observations",
    sends: [],
    reads: ["deleted_count"],
  },
  // openclaw hindsight consolidate [--wait].
  {
    method: "POST",
    path: "/v1/default/banks/{bank_id}/consolidate",
    sends: [],
    reads: ["operation_id", "deduplicated"],
  },
  {
    method: "GET",
    path: "/v1/default/banks/{bank_id}/operations/{operation_id}",
    sends: [],
    reads: [
      "status",
      "operation_type",
      "error_message",
      "progress.stage",
      "progress.processed",
      "progress.total",
      "progress.detail",
    ],
  },
  { method: "GET", path: "/health", sends: [], reads: [] },
  // openclaw hindsight status, doctor and forget.
  { method: "GET", path: "/version", sends: [], reads: ["api_version"] },
  { method: "GET", path: "/v1/default/banks", sends: [], reads: [] },
  {
    method: "GET",
    path: "/v1/default/banks/{bank_id}/documents",
    sends: [],
    reads: ["items[].id", "items[].memory_unit_count"],
  },
  {
    method: "DELETE",
    path: "/v1/default/banks/{bank_id}/documents/{document_id}",
    sends: [],
    reads: ["memory_units_deleted"],
  },
];

/** Keeps only the listed field paths of a shape (types, required lists and enums stay). */
export function pruneShape(shape, paths) {
  if (!shape || paths.length === 0) {
    return null;
  }
  const out = { ...shape };
  delete out.properties;
  delete out.items;
  delete out.additionalProperties;
  if (shape.items) {
    const inner = paths.filter((p) => p.startsWith("[]")).map((p) => p.slice(2).replace(/^\./, ""));
    if (inner.length > 0) {
      out.items = inner.every((p) => p === "") ? shape.items : pruneShape(shape.items, inner);
    }
  }
  if (shape.properties) {
    const byKey = new Map();
    for (const p of paths) {
      const m = /^([^.[\]]+)(.*)$/.exec(p);
      if (!m) {
        continue;
      }
      const rest = m[2].replace(/^\./, "");
      byKey.set(m[1], [...(byKey.get(m[1]) ?? []), rest]);
    }
    out.properties = {};
    for (const [key, rests] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
      const field = shape.properties[key];
      if (!field) {
        // Recorded as missing, so a later server that adds it reads as an addition.
        continue;
      }
      out.properties[key] = rests.every((r) => r === "") ? field : pruneShape(field, rests);
    }
  }
  return out;
}

// Recursive models (TagGroup) and deep trees stop here; a deeper change still shows at the top.
const MAX_DEPTH = 5;

function resolveRef(doc, ref) {
  const parts = ref.replace(/^#\//, "").split("/");
  let node = doc;
  for (const part of parts) {
    node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return node;
}

/** A small, stable description of a schema: types, properties, required, items, unions. */
export function shapeOf(doc, schema, depth = 0, seen = new Set()) {
  if (!schema || typeof schema !== "object") {
    return { type: "any" };
  }
  if (schema.$ref) {
    const name = schema.$ref.split("/").pop();
    if (seen.has(name) || depth >= MAX_DEPTH) {
      return { ref: name };
    }
    return shapeOf(doc, resolveRef(doc, schema.$ref), depth, new Set([...seen, name]));
  }
  const union = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(union)) {
    const variants = union.filter((s) => s?.type !== "null");
    const nullable = variants.length < union.length;
    const shapes = variants.map((s) => shapeOf(doc, s, depth, seen));
    const out = shapes.length === 1 ? { ...shapes[0] } : { anyOf: shapes };
    if (nullable) {
      out.nullable = true;
    }
    return out;
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length === 1) {
    return shapeOf(doc, schema.allOf[0], depth, seen);
  }
  const out = {};
  const type = schema.type ?? (schema.properties ? "object" : undefined);
  if (type) {
    out.type = type;
  }
  if (Array.isArray(schema.enum)) {
    out.enum = [...schema.enum].sort();
  }
  if (type === "array") {
    out.items = shapeOf(doc, schema.items, depth + 1, seen);
  }
  if (schema.properties) {
    out.properties = {};
    for (const key of Object.keys(schema.properties).sort()) {
      out.properties[key] = shapeOf(doc, schema.properties[key], depth + 1, seen);
    }
    out.required = [...(schema.required ?? [])].sort();
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    out.additionalProperties = shapeOf(doc, schema.additionalProperties, depth + 1, seen);
  }
  if (Object.keys(out).length === 0) {
    out.type = "any";
  }
  return out;
}

function jsonSchemaOf(content) {
  return content?.["application/json"]?.schema;
}

/** The contract slice of an OpenAPI document. */
export function extractContract(doc) {
  const operations = {};
  for (const { method, path, sends, reads } of OPERATIONS) {
    const op = doc.paths?.[path]?.[method.toLowerCase()];
    if (!op) {
      continue;
    }
    const params = {};
    for (const raw of op.parameters ?? []) {
      const p = raw.$ref ? resolveRef(doc, raw.$ref) : raw;
      params[`${p.in}:${p.name}`] = { required: Boolean(p.required), ...shapeOf(doc, p.schema) };
    }
    const success = Object.keys(op.responses ?? {})
      .filter((code) => /^2\d\d$/.test(code))
      .sort()[0];
    const request = op.requestBody ? shapeOf(doc, jsonSchemaOf(op.requestBody.content)) : null;
    const response = success ? shapeOf(doc, jsonSchemaOf(op.responses[success].content)) : null;
    operations[`${method} ${path}`] = {
      params,
      request: request && pruneShape(request, sends.length > 0 ? sends : ["\u0000"]),
      response: pruneShape(response, reads),
    };
  }
  return { hindsight: doc.info?.version ?? "unknown", operations };
}

function signature(shape) {
  if (!shape) {
    return "none";
  }
  if (shape.ref) {
    return `ref:${shape.ref}`;
  }
  if (shape.anyOf) {
    return shape.anyOf.map(signature).sort().join("|");
  }
  return shape.type ?? "any";
}

/**
 * Compares two shapes. `side` is "request" (the plugin writes it) or "response" (the plugin reads
 * it). A field that disappears or changes type breaks both; a new required request field breaks
 * the request. Enum changes are listed as additions or removals by value.
 */
function diffShape(path, before, after, side, out) {
  if (!before) {
    return;
  }
  if (!after) {
    out.breaking.push(`${path}: removed`);
    return;
  }
  const a = signature(before);
  const b = signature(after);
  if (a !== b) {
    out.breaking.push(`${path}: type ${a} -> ${b}`);
    return;
  }
  if (before.enum || after.enum) {
    const old = new Set(before.enum ?? []);
    const now = new Set(after.enum ?? []);
    for (const v of old) {
      if (!now.has(v)) {
        out.breaking.push(`${path}: enum value ${JSON.stringify(v)} removed`);
      }
    }
    for (const v of now) {
      if (!old.has(v)) {
        out.additions.push(`${path}: enum value ${JSON.stringify(v)} added`);
      }
    }
  }
  if (before.items || after.items) {
    diffShape(`${path}[]`, before.items, after.items, side, out);
  }
  if (before.anyOf && after.anyOf) {
    before.anyOf.forEach((s, i) => diffShape(`${path}|${i}`, s, after.anyOf[i], side, out));
  }
  const props = before.properties ?? {};
  const nextProps = after.properties ?? {};
  for (const key of Object.keys(props)) {
    diffShape(`${path}.${key}`, props[key], nextProps[key], side, out);
  }
  for (const key of Object.keys(nextProps)) {
    if (!(key in props)) {
      out.additions.push(`${path}.${key}: added`);
    }
  }
  if (side === "request") {
    // Pruning keeps the full required list, so a new required field shows even when the plugin
    // never sends it.
    const required = new Set(before.required ?? []);
    for (const key of after.required ?? []) {
      if (!required.has(key)) {
        out.breaking.push(
          `${path}.${key}: ${key in props ? "now required" : "new required field"}`,
        );
      }
    }
  }
}

/** What changed between the recorded contract and a server's: { breaking, additions }. */
export function diffContract(recorded, current) {
  const out = { breaking: [], additions: [] };
  for (const [key, before] of Object.entries(recorded.operations)) {
    const after = current.operations[key];
    if (!after) {
      out.breaking.push(`${key}: route removed`);
      continue;
    }
    for (const [name, p] of Object.entries(before.params)) {
      const q = after.params[name];
      if (!q) {
        out.breaking.push(`${key} ${name}: parameter removed`);
      } else if (signature(p) !== signature(q)) {
        out.breaking.push(`${key} ${name}: type ${signature(p)} -> ${signature(q)}`);
      }
    }
    for (const [name, q] of Object.entries(after.params)) {
      if (!before.params[name]) {
        (q.required ? out.breaking : out.additions).push(
          `${key} ${name}: ${q.required ? "new required parameter" : "parameter added"}`,
        );
      }
    }
    diffShape(`${key} request`, before.request, after.request, "request", out);
    diffShape(`${key} response`, before.response, after.response, "response", out);
  }
  return out;
}

async function loadDocument(source) {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`GET ${source} answered HTTP ${response.status}`);
    }
    return response.json();
  }
  return JSON.parse(readFileSync(source, "utf8"));
}

async function main(argv) {
  const [command, source, ...rest] = argv;
  if (!["extract", "check"].includes(command) || !source) {
    process.stderr.write(
      "usage: api-contract.mjs extract <openapi.json|URL>\n       api-contract.mjs check <openapi.json|URL> [--fixture PATH]\n",
    );
    return 2;
  }
  let fixture = DEFAULT_FIXTURE;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--fixture" && rest[i + 1]) {
      fixture = rest[++i];
    } else {
      process.stderr.write(`api-contract: unknown argument ${rest[i]}\n`);
      return 2;
    }
  }
  let doc;
  try {
    doc = await loadDocument(source);
  } catch (error) {
    process.stderr.write(`api-contract: cannot read ${source}: ${error.message}\n`);
    return 2;
  }
  const current = extractContract(doc);
  if (command === "extract") {
    process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
    return 0;
  }
  const recorded = JSON.parse(readFileSync(fixture, "utf8"));
  const { breaking, additions } = diffContract(recorded, current);
  process.stdout.write(
    `Hindsight API contract: recorded ${recorded.hindsight}, server ${current.hindsight}\n`,
  );
  for (const line of breaking) {
    process.stdout.write(`BREAKING ${line}\n`);
  }
  for (const line of additions) {
    process.stdout.write(`added    ${line}\n`);
  }
  process.stdout.write(
    breaking.length === 0
      ? `OK: no change the plugin depends on (${additions.length} additions)\n`
      : `DRIFT: ${breaking.length} breaking change(s)\n`,
  );
  return breaking.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}
