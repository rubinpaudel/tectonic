import type { JsonValue, Pagination } from "@tunnelvision/core";

export function pagination(input: Pagination): { limit: number; offset: number } {
  const limit = input.limit === undefined ? 50 : input.limit;
  const offset = input.offset === undefined ? 0 : input.offset;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("limit must be an integer between 1 and 100");
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("offset must be a non-negative safe integer");
  }
  return { limit, offset };
}

/** Stable JSON encoding makes retries independent of object key insertion order. */
export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`,
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function isoTimestamp(value: string): string {
  return new Date(value).toISOString();
}

export function literalLike(value: string): string {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

export function page<T>(rows: T[], limit: number, offset: number): {
  items: T[];
  nextOffset: number | null;
} {
  return { items: rows.slice(0, limit), nextOffset: rows.length > limit ? offset + limit : null };
}
