import { describe, expect, it } from "vitest";
import { canonicalJson, literalLike, page, pagination } from "../src/utils.js";
import { createMemoryRepository } from "../src/repository.js";

describe("database contract helpers", () => {
  it("validates paging rather than silently clamping invalid values", () => {
    expect(pagination({})).toEqual({ limit: 50, offset: 0 });
    expect(pagination({ limit: 100, offset: 7 })).toEqual({ limit: 100, offset: 7 });
    for (const limit of [0, 101, -1, 1.5, NaN, Infinity, null as unknown as number]) expect(() => pagination({ limit })).toThrow(RangeError);
    for (const offset of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null as unknown as number]) expect(() => pagination({ offset })).toThrow(RangeError);
  });

  it("detects another page without inventing an offset at the end", () => {
    expect(page(["a", "b", "c"], 2, 4)).toEqual({ items: ["a", "b"], nextOffset: 6 });
    expect(page(["a", "b"], 2, 4)).toEqual({ items: ["a", "b"], nextOffset: null });
    expect(page([], 2, 99)).toEqual({ items: [], nextOffset: null });
  });

  it("canonicalizes nested object keys but preserves array order and values", () => {
    expect(canonicalJson({ z: null, a: [{ y: 2, x: 1 }] })).toBe(canonicalJson({ a: [{ x: 1, y: 2 }], z: null }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    expect(canonicalJson({ quote: "a\"b\nc" })).toBe('{"quote":"a\\"b\\nc"}');
  });

  it("treats user search text as literal substrings", () => {
    expect(literalLike("100%_\\done")).toBe("%100\\%\\_\\\\done%");
  });

  it("rejects invalid public queries before making a database connection", async () => {
    const repository = createMemoryRepository({ connectionString: "postgresql://unused:unused@127.0.0.1:1/unused" });
    try {
      await expect(repository.searchMemories({ tenantId: "nike", limit: 0 })).rejects.toThrow(RangeError);
      await expect(repository.getTimeline({ tenantId: "nike", from: "yesterday" })).rejects.toThrow();
      await expect(repository.getRelatedMemories({ tenantId: "nike", memoryId: "m", offset: -1 })).rejects.toThrow(RangeError);
      await expect(repository.listTenants({ limit: 101 })).rejects.toThrow(RangeError);
    } finally { await repository.close(); }
  });
});
