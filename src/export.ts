import { promises as fs } from "node:fs";
import path from "node:path";
import { MEMORY_MAX_RESPONSE_BYTES } from "./client.js";

/**
 * `openclaw hindsight export`: a bank's memories as markdown, so they can be read, diffed and kept
 * beside the workspace memory files. One file per memory type (world facts, experiences,
 * observations) and, on request, one file per mental model, plus an INDEX.md.
 *
 * Read only: GET /memories/list and GET /mental-models (Hindsight 1.2.1). Pages are fetched until
 * `total` is reached or `maxItems` per type is hit, which the index then reports.
 */

export const EXPORT_TYPES = ["world", "experience", "observation"] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

const TYPE_FILES: Record<ExportType, { file: string; title: string }> = {
  world: { file: "facts.md", title: "World facts" },
  experience: { file: "experiences.md", title: "Experiences" },
  observation: { file: "observations.md", title: "Observations" },
};

export const EXPORT_PAGE_SIZE = 200;
export const EXPORT_DEFAULT_MAX_ITEMS = 50_000;

export type ExportMemory = {
  id: string;
  text: string;
  date?: string;
  documentId?: string;
  tags: string[];
  state?: string;
};

export type ExportMentalModel = {
  id: string;
  name: string;
  content: string;
  sourceQuery?: string;
  lastRefreshedAt?: string;
  tags: string[];
};

type Page<T> = { items: T[]; total: number };

/** The read calls export needs; createHttpExportSource is the real one. */
export type ExportSource = {
  listMemories(
    bankId: string,
    type: ExportType,
    page: { limit: number; offset: number },
  ): Promise<Page<ExportMemory>>;
  listMentalModels(
    bankId: string,
    page: { limit: number; offset: number },
  ): Promise<Page<ExportMentalModel>>;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function total(body: Record<string, unknown>, itemCount: number): number {
  return typeof body.total === "number" && Number.isFinite(body.total) ? body.total : itemCount;
}

export function parseMemoryPage(body: unknown): Page<ExportMemory> {
  const record = (body ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(record.items) ? record.items : [];
  const items: ExportMemory[] = [];
  for (const entry of raw) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const id = str(item.id);
    const text = typeof item.text === "string" ? item.text : undefined;
    if (!id || text === undefined) {
      continue;
    }
    items.push({
      id,
      text,
      date: str(item.occurred_start) ?? str(item.date) ?? str(item.mentioned_at),
      documentId: str(item.document_id),
      tags: strings(item.tags),
      state: str(item.state),
    });
  }
  return { items, total: total(record, raw.length) };
}

export function parseMentalModelPage(body: unknown): Page<ExportMentalModel> {
  const record = (body ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(record.items) ? record.items : [];
  const items: ExportMentalModel[] = [];
  for (const entry of raw) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const id = str(item.id);
    if (!id) {
      continue;
    }
    items.push({
      id,
      name: str(item.name) ?? id,
      content: typeof item.content === "string" ? item.content : "",
      sourceQuery: str(item.source_query),
      lastRefreshedAt: str(item.last_refreshed_at),
      tags: strings(item.tags),
    });
  }
  return { items, total: total(record, raw.length) };
}

/** Real source over fetch; token in the Authorization header, bodies bounded like the client's. */
export function createHttpExportSource(params: {
  apiUrl: string;
  apiToken?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  userAgent?: string;
}): ExportSource {
  const doFetch = params.fetch ?? ((input, init) => fetch(input, init));
  const base = params.apiUrl.replace(/\/+$/, "");
  const get = async (url: string, what: string): Promise<unknown> => {
    const response = await doFetch(url, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/json",
        "User-Agent": params.userAgent ?? "openclaw-memory-hindsight",
        ...(params.apiToken ? { Authorization: `Bearer ${params.apiToken}` } : {}),
      },
      signal: AbortSignal.timeout(params.timeoutMs ?? 30_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Hindsight ${what} failed: HTTP ${response.status}`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > MEMORY_MAX_RESPONSE_BYTES) {
      throw new Error(
        `Hindsight ${what} failed: response larger than ${MEMORY_MAX_RESPONSE_BYTES} bytes`,
      );
    }
    return text ? JSON.parse(text) : {};
  };
  const bankUrl = (bankId: string, suffix: string) =>
    `${base}/v1/default/banks/${encodeURIComponent(bankId)}${suffix}`;
  return {
    async listMemories(bankId, type, page) {
      const query = new URLSearchParams({
        type,
        limit: String(page.limit),
        offset: String(page.offset),
      });
      return parseMemoryPage(await get(bankUrl(bankId, `/memories/list?${query}`), "memory list"));
    },
    async listMentalModels(bankId, page) {
      const query = new URLSearchParams({ limit: String(page.limit), offset: String(page.offset) });
      return parseMentalModelPage(
        await get(bankUrl(bankId, `/mental-models?${query}`), "mental model list"),
      );
    },
  };
}

async function collect<T>(
  fetchPage: (page: { limit: number; offset: number }) => Promise<Page<T>>,
  maxItems: number,
): Promise<{ items: T[]; total: number; truncated: boolean }> {
  const items: T[] = [];
  let reported = 0;
  for (let offset = 0; items.length < maxItems;) {
    const page = await fetchPage({
      limit: Math.min(EXPORT_PAGE_SIZE, maxItems - items.length),
      offset,
    });
    reported = page.total;
    items.push(...page.items);
    offset += page.items.length;
    if (page.items.length === 0 || offset >= page.total) {
      break;
    }
  }
  return { items: items.slice(0, maxItems), total: reported, truncated: reported > items.length };
}

/** Markdown inline text: one line, no HTML, no heading or list markers at the start. */
function inline(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function slugify(value: string, fallback: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}

export function renderMemories(
  title: string,
  bankId: string,
  memories: readonly ExportMemory[],
): string {
  const sorted = memories.toSorted(
    (a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.id.localeCompare(b.id),
  );
  const lines = [
    `# ${title}`,
    "",
    `Bank \`${bankId}\`, ${sorted.length} memories, oldest first.`,
    "",
  ];
  for (const memory of sorted) {
    const meta = [
      memory.date ? memory.date.slice(0, 10) : undefined,
      memory.documentId ? `doc:${inline(memory.documentId)}` : undefined,
      memory.tags.length ? `tags: ${memory.tags.map(inline).join(", ")}` : undefined,
      memory.state && memory.state !== "valid" ? `state: ${inline(memory.state)}` : undefined,
      `id:${memory.id}`,
    ].filter(Boolean);
    lines.push(`- ${inline(memory.text)} (${meta.join("; ")})`);
  }
  return `${lines.join("\n")}\n`;
}

export function renderMentalModel(bankId: string, model: ExportMentalModel): string {
  const meta = [
    `Bank \`${bankId}\`, mental model \`${model.id}\``,
    model.sourceQuery ? `Source query: ${inline(model.sourceQuery)}` : undefined,
    model.lastRefreshedAt ? `Last refreshed: ${model.lastRefreshedAt}` : undefined,
    model.tags.length ? `Tags: ${model.tags.map(inline).join(", ")}` : undefined,
  ].filter(Boolean);
  return `# ${inline(model.name)}\n\n${meta.join("\n\n")}\n\n${model.content.trim()}\n`;
}

export type ExportFile = { rel: string; content: string };

export type ExportSummary = {
  bankId: string;
  types: Array<{
    type: ExportType;
    file: string;
    count: number;
    total: number;
    truncated: boolean;
  }>;
  mentalModels?: { count: number; total: number; truncated: boolean };
};

export async function buildBankExport(params: {
  source: ExportSource;
  bankId: string;
  types?: readonly ExportType[];
  mentalModels?: boolean;
  maxItems?: number;
}): Promise<{ files: ExportFile[]; summary: ExportSummary }> {
  const maxItems = params.maxItems ?? EXPORT_DEFAULT_MAX_ITEMS;
  const types = params.types?.length ? params.types : EXPORT_TYPES;
  const files: ExportFile[] = [];
  const summary: ExportSummary = { bankId: params.bankId, types: [] };
  for (const type of types) {
    const got = await collect(
      (page) => params.source.listMemories(params.bankId, type, page),
      maxItems,
    );
    const { file, title } = TYPE_FILES[type];
    files.push({ rel: file, content: renderMemories(title, params.bankId, got.items) });
    summary.types.push({
      type,
      file,
      count: got.items.length,
      total: got.total,
      truncated: got.truncated,
    });
  }
  if (params.mentalModels) {
    const got = await collect(
      (page) => params.source.listMentalModels(params.bankId, page),
      maxItems,
    );
    const used = new Set<string>();
    for (const model of got.items) {
      let slug = slugify(model.name, model.id);
      if (used.has(slug)) {
        slug = `${slug}-${slugify(model.id, "x").slice(0, 12)}`;
      }
      used.add(slug);
      files.push({
        rel: `mental-models/${slug}.md`,
        content: renderMentalModel(params.bankId, model),
      });
    }
    summary.mentalModels = { count: got.items.length, total: got.total, truncated: got.truncated };
  }
  const index = [
    `# Hindsight export: bank \`${params.bankId}\``,
    "",
    ...summary.types.map(
      (t) =>
        `- [${TYPE_FILES[t.type].title}](${t.file}): ${t.count}${t.truncated ? ` of ${t.total} (truncated at --max-items)` : ""}`,
    ),
    ...(summary.mentalModels
      ? [
          `- Mental models (mental-models/): ${summary.mentalModels.count}${summary.mentalModels.truncated ? ` of ${summary.mentalModels.total} (truncated)` : ""}`,
        ]
      : []),
    "",
  ].join("\n");
  files.unshift({ rel: "INDEX.md", content: index });
  return { files, summary };
}

/**
 * Writes the export under outDir/<bank>/. Refuses a non-empty target unless `overwrite`, and never
 * writes outside it.
 */
export async function writeBankExport(params: {
  outDir: string;
  bankId: string;
  files: readonly ExportFile[];
  overwrite?: boolean;
}): Promise<string> {
  const target = path.resolve(params.outDir, slugify(params.bankId, "bank"));
  const existing = await fs.readdir(target).catch(() => [] as string[]);
  if (existing.length > 0 && !params.overwrite) {
    throw new Error(`${target} is not empty; pass --overwrite to replace its files`);
  }
  for (const file of params.files) {
    const abs = path.resolve(target, file.rel);
    if (!abs.startsWith(`${target}${path.sep}`)) {
      throw new Error(`refusing to write outside ${target}: ${file.rel}`);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, file.content, { mode: 0o600 });
  }
  return target;
}
