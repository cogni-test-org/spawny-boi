// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Domain SQL operations use caller-owned admission; native custody is proven separately. */
import { describe, expect, it, vi } from "vitest";
import {
  deleteDoltgresDomain,
  getDoltgresDomain,
  updateDoltgresDomain,
} from "../src/adapters/doltgres/index.js";
import {
  DomainNotEmptyError,
  DomainNotRegisteredError,
} from "../src/port/knowledge-store.port.js";

const row = {
  id: "meta",
  name: "Meta",
  description: "Shared guidance",
  confidence_pct: "60",
  entry_count: "2",
  created_at: new Date("2026-10-01T00:00:00.000Z"),
};

function queryReturning(...results: Record<string, unknown>[][]) {
  return vi.fn(
    async (_query: string): Promise<readonly Record<string, unknown>[]> => {
      const result = results.shift();
      if (!result) throw new Error("Unexpected extra query");
      return result;
    },
  );
}

describe("caller-scoped Doltgres domain operations", () => {
  it("returns null for an absent domain and normalizes live counts and dates", async () => {
    expect(await getDoltgresDomain(queryReturning([]), "missing")).toBeNull();
    expect(await getDoltgresDomain(queryReturning([row]), "meta")).toEqual({
      id: "meta",
      name: "Meta",
      description: "Shared guidance",
      confidencePct: 60,
      entryCount: 2,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    expect(
      await getDoltgresDomain(
        queryReturning([
          {
            id: "meta",
            name: "Meta",
            created_at: "2026-10-01",
          },
        ]),
        "meta",
      ),
    ).toMatchObject({
      description: null,
      confidencePct: 40,
      entryCount: 0,
      createdAt: "2026-10-01",
    });
  });

  it.each([{}, { name: "Meta" }, { description: "Shared guidance" }])(
    "does not write for omitted or unchanged patch %j",
    async (patch) => {
      const query = queryReturning([row]);
      expect(await updateDoltgresDomain(query, "meta", patch)).toMatchObject({
        name: "Meta",
      });
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0]?.[0]).toMatch(/^SELECT /);
    },
  );

  it("clears description with null and returns the updated row", async () => {
    const query = queryReturning([row], [], [{ ...row, description: null }]);
    expect(
      await updateDoltgresDomain(query, "meta", { description: null }),
    ).toMatchObject({ description: null });
    expect(query.mock.calls[1]?.[0]).toBe(
      "UPDATE domains SET description = NULL WHERE id = 'meta'",
    );
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("escapes ids and patch values without changing domain identity", async () => {
    const query = queryReturning(
      [row],
      [],
      [{ ...row, name: "Writer's guide" }],
    );
    await updateDoltgresDomain(query, "m'eta", { name: "Writer's guide" });
    expect(query.mock.calls[0]?.[0]).toContain("WHERE d.id = 'm''eta'");
    expect(query.mock.calls[1]?.[0]).toBe(
      "UPDATE domains SET name = 'Writer''s guide' WHERE id = 'm''eta'",
    );
  });

  it.each(["update", "delete"])(
    "refuses missing domain on %s before DML",
    async (operation) => {
      const query = queryReturning([]);
      const result =
        operation === "update"
          ? updateDoltgresDomain(query, "missing", { name: "New" })
          : deleteDoltgresDomain(query, "missing");
      await expect(result).rejects.toBeInstanceOf(DomainNotRegisteredError);
      await expect(result).rejects.toMatchObject({ domain: "missing" });
      expect(query).toHaveBeenCalledTimes(1);
    },
  );

  it("refuses nonempty deletion with the live count and no DML", async () => {
    const query = queryReturning([row]);
    const result = deleteDoltgresDomain(query, "meta");
    await expect(result).rejects.toBeInstanceOf(DomainNotEmptyError);
    await expect(result).rejects.toMatchObject({
      domain: "meta",
      entryCount: 2,
    });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("deletes an empty domain once with escaped id", async () => {
    const query = queryReturning([{ ...row, entry_count: 0 }], []);
    await expect(deleteDoltgresDomain(query, "m'eta")).resolves.toBeUndefined();
    expect(query.mock.calls[1]?.[0]).toBe(
      "DELETE FROM domains WHERE id = 'm''eta'",
    );
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("propagates the original SQL error object from reads and DML", async () => {
    const error = new Error("native query failed");
    const query = vi.fn(
      async (_query: string): Promise<readonly Record<string, unknown>[]> => {
        throw error;
      },
    );
    await expect(getDoltgresDomain(query, "meta")).rejects.toBe(error);
    query.mockResolvedValueOnce([row]);
    await expect(
      updateDoltgresDomain(query, "meta", { name: "New" }),
    ).rejects.toBe(error);
    query.mockResolvedValueOnce([{ ...row, entry_count: 0 }]);
    await expect(deleteDoltgresDomain(query, "meta")).rejects.toBe(error);
  });
});
