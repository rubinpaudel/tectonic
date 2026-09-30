import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { JsonObject, Observation, SourceParseInput, SourceParser, SourceSystem } from "@tunnelvision/core";

const execute = promisify(execFile);
export const normalizeText = (text: string): string => text.replace(/\r\n?/g, "\n").replace(/[\t ]+$/gm, "").trim();

function check(input: SourceParseInput, system: SourceSystem): void {
  if (input.source.system !== system || input.source.tenantId !== input.version.tenantId || input.source.id !== input.version.sourceId) {
    throw new Error("Parser source/version tenant, identity, or system mismatch");
  }
}

function observation(input: SourceParseInput, suffix: string, text: string, locator: JsonObject, metadata: JsonObject = {}): Observation {
  return {
    id: `${input.version.id}:${suffix}`, tenantId: input.source.tenantId, text,
    evidence: [{ sourceId: input.source.id, sourceVersionId: input.version.id, locator, quote: text.slice(0, 900) }],
    metadata: { system: input.source.system, path: input.source.externalId, ...metadata },
  };
}

export class TxtSourceParser implements SourceParser {
  constructor(readonly system: SourceSystem = "gmail") {}
  async parse(input: SourceParseInput): Promise<Observation[]> {
    check(input, this.system);
    const text = normalizeText(input.version.content);
    if (!text) return [];
    const metadata: JsonObject = {};
    for (const field of ["From", "To", "Date", "Message-ID", "Subject"]) {
      const match = text.match(new RegExp(`^${field}:\\s*(.+)$`, "mi"));
      if (match?.[1]) metadata[field.toLowerCase()] = match[1].trim();
    }
    const messageId = typeof metadata["message-id"] === "string" ? metadata["message-id"].replace(/^<|>$/g, "") : "";
    return [observation(input, "text", text, { lineStart: 1, lineEnd: text.split("\n").length, ...(messageId ? { messageId } : {}) }, metadata)];
  }
}

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";

export class JsonSourceParser implements SourceParser {
  constructor(readonly system: SourceSystem = "teams") {}
  async parse(input: SourceParseInput): Promise<Observation[]> {
    check(input, this.system);
    const data: unknown = JSON.parse(input.version.content);
    const root = object(data);
    if (root.tenantId !== undefined && root.tenantId !== input.source.tenantId) throw new Error("Teams export tenant mismatch");
    const messages = Array.isArray(root.messages) ? root.messages : Array.isArray(data) ? data : null;
    if (!messages) throw new Error("Teams export must contain a messages array");
    const observations: Observation[] = [];
    for (const [index, value] of messages.entries()) {
      const message = object(value);
      const body = message.body;
      const text = normalizeText(typeof body === "string" ? body : string(object(body).content) || string(message.content) || string(message.text));
      if (!text) continue;
      const from = object(message.from);
      const metadata: JsonObject = {
        channel: string(root.channel) || string(object(root.channel).displayName),
        messageId: string(message.id), createdDateTime: string(message.createdDateTime),
        employeeId: string(message.employeeId),
        from: { id: string(from.id), displayName: string(from.displayName), email: string(from.email) },
        mentions: JSON.parse(JSON.stringify(message.mentions ?? [])) as JsonObject["mentions"],
      };
      observations.push(observation(input, `message:${index}`, text, {
        jsonPointer: Array.isArray(data) ? `/${index}/body/content` : `/messages/${index}/body/content`,
        messageId: string(message.id),
      }, metadata));
    }
    return observations;
  }
}

/** PDF bytes are converted once, before the immutable text snapshot is stored. */
export async function extractPdfText(bytes: Uint8Array, executable = "pdftotext"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tunnelvision-pdf-"));
  try {
    const input = join(directory, "source.pdf");
    const output = join(directory, "source.txt");
    await writeFile(input, bytes);
    await execute(executable, ["-layout", "-enc", "UTF-8", input, output], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    return normalizeText(await readFile(output, "utf8"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export class PdfSourceParser implements SourceParser {
  constructor(readonly system: SourceSystem = "sharepoint") {}
  async parse(input: SourceParseInput): Promise<Observation[]> {
    check(input, this.system);
    const text = normalizeText(input.version.content);
    if (!text) return [];
    // Keep multi-page dossier fields together; evidence still identifies pages.
    return [observation(input, "pdf", text, { pageStart: 1, pageEnd: text.split("\f").filter(page => page.trim()).length || 1 })];
  }
}
