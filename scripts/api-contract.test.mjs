// Tests for scripts/api-contract.mjs (node --test). Offline: synthetic OpenAPI documents only.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_FIXTURE,
  diffContract,
  extractContract,
  OPERATIONS,
  pruneShape,
} from "./api-contract.mjs";

const SCRIPT = new URL("./api-contract.mjs", import.meta.url).pathname;
const RECALL = "/v1/default/banks/{bank_id}/memories/recall";

/** A tiny OpenAPI document with the recall route only. */
function doc(mutate = () => undefined) {
  const d = {
    info: { version: "9.9.9" },
    paths: {
      [RECALL]: {
        post: {
          parameters: [{ name: "bank_id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            content: { "application/json": { schema: { $ref: "#/components/schemas/Req" } } },
          },
          responses: {
            200: {
              content: { "application/json": { schema: { $ref: "#/components/schemas/Res" } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        Req: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string" },
            budget: { type: "string", enum: ["low", "mid", "high"] },
            max_tokens: { type: "integer" },
            types: { anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }] },
            prefer_observations: { type: "boolean" },
            min_scores: { type: "object", properties: { final: { type: "number" } } },
            tag_groups: { type: "array", items: { $ref: "#/components/schemas/Group" } },
            trace: { type: "boolean" },
          },
        },
        Group: {
          anyOf: [
            { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } },
            { type: "object", properties: { not: { $ref: "#/components/schemas/Group" } } },
          ],
        },
        Res: {
          type: "object",
          required: ["results"],
          properties: {
            results: {
              type: "array",
              items: {
                type: "object",
                required: ["id", "text"],
                properties: {
                  id: { type: "string" },
                  text: { type: "string" },
                  type: { anyOf: [{ type: "string" }, { type: "null" }] },
                  chunk_id: { type: "string" },
                },
              },
            },
            trace: { type: "object" },
          },
        },
      },
    },
  };
  mutate(d);
  return d;
}

const req = (d) => d.components.schemas.Req;
const res = (d) => d.components.schemas.Res.properties.results.items;
const diff = (mutate) => diffContract(extractContract(doc()), extractContract(doc(mutate)));

test("extracts only the fields the client sends and reads", () => {
  const c = extractContract(doc());
  assert.equal(c.hindsight, "9.9.9");
  const op = c.operations[`POST ${RECALL}`];
  assert.deepEqual(Object.keys(op.params), ["path:bank_id"]);
  assert.ok(op.request.properties.query);
  assert.equal(op.request.properties.trace, undefined, "not sent, so not recorded");
  assert.deepEqual(op.request.required, ["query"]);
  assert.deepEqual(Object.keys(op.response.properties.results.items.properties).sort(), [
    "id",
    "text",
    "type",
  ]);
  assert.equal(op.response.properties.trace, undefined, "not read, so not recorded");
  // Routes the document lacks are left out, and so read as removed against a full recording.
  assert.equal(c.operations["GET /health"], undefined);
});

test("unions keep nullable apart from their variants, and recursion stops", () => {
  const op = extractContract(doc()).operations[`POST ${RECALL}`];
  assert.deepEqual(op.request.properties.types, {
    type: "array",
    items: { type: "string" },
    nullable: true,
  });
  assert.match(JSON.stringify(op.request.properties.tag_groups), /"ref":"Group"/);
});

test("pruneShape walks array items and nested objects", () => {
  const shape = {
    type: "object",
    properties: {
      a: {
        type: "array",
        items: { type: "object", properties: { b: { type: "string" }, c: { type: "number" } } },
      },
      d: { type: "string" },
    },
  };
  assert.deepEqual(pruneShape(shape, ["a[].b"]), {
    type: "object",
    properties: {
      a: { type: "array", items: { type: "object", properties: { b: { type: "string" } } } },
    },
  });
  assert.equal(pruneShape(shape, []), null);
});

test("no change, and additions only, are not drift", () => {
  assert.deepEqual(diff(), { breaking: [], additions: [] });
  const added = diff((d) => {
    req(d).properties.new_option = { type: "boolean" };
    d.paths[RECALL].post.parameters.push({ name: "x", in: "query", schema: { type: "string" } });
  });
  assert.deepEqual(added.breaking, []);
  assert.deepEqual(added.additions, [`POST ${RECALL} query:x: parameter added`]);
});

test("reports what breaks the plugin", () => {
  const cases = [
    [(d) => delete req(d).properties.budget, /request\.budget: removed/],
    [
      (d) => (req(d).properties.max_tokens = { type: "string" }),
      /request\.max_tokens: type integer -> string/,
    ],
    [(d) => req(d).required.push("trace"), /request\.trace: new required field/],
    [(d) => req(d).required.push("budget"), /request\.budget: now required/],
    [
      (d) => (req(d).properties.budget.enum = ["low", "mid"]),
      /request\.budget: enum value "high" removed/,
    ],
    [(d) => delete res(d).properties.text, /response\.results\[\]\.text: removed/],
    [
      (d) => (res(d).properties.id = { type: "integer" }),
      /response\.results\[\]\.id: type string -> integer/,
    ],
    [(d) => (d.paths[RECALL].post.parameters = []), /path:bank_id: parameter removed/],
    [
      (d) =>
        d.paths[RECALL].post.parameters.push({
          name: "k",
          in: "header",
          required: true,
          schema: { type: "string" },
        }),
      /header:k: new required parameter/,
    ],
    [(d) => delete d.paths[RECALL], /route removed/],
  ];
  for (const [mutate, expected] of cases) {
    const out = diff(mutate);
    assert.ok(
      out.breaking.some((line) => expected.test(line)),
      `${expected} not in ${JSON.stringify(out.breaking)}`,
    );
  }
});

test("changes in fields the plugin does not use are not reported", () => {
  const out = diff((d) => {
    delete res(d).properties.chunk_id;
    req(d).properties.trace = { type: "string" };
  });
  assert.deepEqual(out, { breaking: [], additions: [] });
});

test("the CLI exits 0 when clean, 1 on drift and 2 on usage or read errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "hs-contract-"));
  try {
    const base = join(dir, "base.json");
    const fixture = join(dir, "fixture.json");
    const drifted = join(dir, "drifted.json");
    writeFileSync(base, JSON.stringify(doc()));
    const extracted = spawnSync(process.execPath, [SCRIPT, "extract", base], { encoding: "utf8" });
    assert.equal(extracted.status, 0, extracted.stderr);
    writeFileSync(fixture, extracted.stdout);
    const clean = spawnSync(process.execPath, [SCRIPT, "check", base, "--fixture", fixture], {
      encoding: "utf8",
    });
    assert.equal(clean.status, 0, clean.stdout);
    assert.match(clean.stdout, /OK: no change the plugin depends on/);
    writeFileSync(drifted, JSON.stringify(doc((d) => delete res(d).properties.text)));
    const bad = spawnSync(process.execPath, [SCRIPT, "check", drifted, "--fixture", fixture], {
      encoding: "utf8",
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /BREAKING .*results\[\]\.text: removed/);
    assert.match(bad.stdout, /DRIFT: 1 breaking change/);
    assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).status, 2);
    assert.equal(
      spawnSync(process.execPath, [SCRIPT, "check", join(dir, "missing.json")], {
        encoding: "utf8",
      }).status,
      2,
    );
    assert.equal(
      spawnSync(process.execPath, [SCRIPT, "check", base, "--bogus"], { encoding: "utf8" }).status,
      2,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the recorded fixture covers every operation, recorded from Hindsight 1.2.1", () => {
  const fixture = JSON.parse(readFileSync(DEFAULT_FIXTURE, "utf8"));
  assert.equal(fixture.hindsight, "1.2.1");
  assert.deepEqual(
    Object.keys(fixture.operations).sort(),
    OPERATIONS.map((o) => `${o.method} ${o.path}`).sort(),
  );
  // Re-extracting from the fixture's own shape cannot be done (it is a slice), but it must be
  // stable: keys sorted, so a re-recording diffs cleanly.
  const recall = fixture.operations[`POST ${RECALL}`];
  assert.deepEqual(
    Object.keys(recall.request.properties),
    Object.keys(recall.request.properties).sort(),
  );
});
