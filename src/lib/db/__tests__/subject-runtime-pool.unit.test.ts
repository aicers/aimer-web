// Unit tests for the #523 subject→pools resolver: a customer subject opens
// its customer DB (no member pools), a group subject opens the group DB plus
// the ordered member pools, and an unknown subject throws. No real DB — the
// auth pool is faked and `getGroupWithMembers` is stubbed so the resolver's
// branch logic is exercised in isolation.

import { describe, expect, it, vi } from "vitest";

// Bypass the server-only guard and avoid pulling real pg connection setup
// from the runtime-pool modules (pool factories are injected per call below).
vi.mock("server-only", () => ({}));
vi.mock("../customer-runtime-pool", () => ({
  getCustomerRuntimePool: vi.fn(),
}));
vi.mock("../group-runtime-pool", () => ({ getGroupRuntimePool: vi.fn() }));
vi.mock("../../groups/groups", () => ({ getGroupWithMembers: vi.fn() }));

import { getGroupWithMembers } from "../../groups/groups";
import { resolveSubjectPools } from "../subject-runtime-pool";

const getGroupWithMembersMock = vi.mocked(getGroupWithMembers);

// A fake auth pool: `query` answers the `subjects.kind` lookup from `kind`,
// and `connect` hands back a client whose `release` is a no-op (the member
// fetch goes through the stubbed `getGroupWithMembers`).
function fakeAuthPool(kind: "customer" | "group" | null) {
  const client = { query: vi.fn(), release: vi.fn() };
  const pool = {
    query: vi.fn(async () => ({
      rows: kind === null ? [] : [{ kind }],
    })),
    connect: vi.fn(async () => client),
    // biome-ignore lint/suspicious/noExplicitAny: minimal Pool stand-in
  } as any;
  return { pool, client };
}

// Distinct sentinel pools so assertions can tell which factory was called for
// which id.
function makePoolFactory() {
  const calls: string[] = [];
  const fn = vi.fn((id: string) => {
    calls.push(id);
    return { __id: id } as unknown as import("pg").Pool;
  });
  return { fn, calls };
}

describe("resolveSubjectPools", () => {
  it("opens the customer DB and no member pools for a customer subject", async () => {
    const { pool } = fakeAuthPool("customer");
    const customer = makePoolFactory();
    const group = makePoolFactory();

    const result = await resolveSubjectPools(pool, "cust-1", {
      getCustomerPool: customer.fn,
      getGroupPool: group.fn,
    });

    expect(result.kind).toBe("customer");
    expect(result.resultPool).toEqual({ __id: "cust-1" });
    expect(result.memberPools).toEqual([]);
    expect(customer.calls).toEqual(["cust-1"]);
    expect(group.fn).not.toHaveBeenCalled();
    expect(getGroupWithMembersMock).not.toHaveBeenCalled();
  });

  it("opens the group DB plus ordered member pools for a group subject", async () => {
    const { pool, client } = fakeAuthPool("group");
    const customer = makePoolFactory();
    const group = makePoolFactory();
    getGroupWithMembersMock.mockResolvedValueOnce({
      // biome-ignore lint/suspicious/noExplicitAny: only memberIds is read
      group: {} as any,
      memberIds: ["mem-a", "mem-b"],
    });

    const result = await resolveSubjectPools(pool, "grp-1", {
      getCustomerPool: customer.fn,
      getGroupPool: group.fn,
    });

    expect(result.kind).toBe("group");
    // Result DB is the GROUP DB, not a customer DB.
    expect(result.resultPool).toEqual({ __id: "grp-1" });
    expect(group.calls).toEqual(["grp-1"]);
    // Member pools are the member ids in order, each via the customer factory.
    expect(result.memberPools).toEqual([
      { customerId: "mem-a", pool: { __id: "mem-a" } },
      { customerId: "mem-b", pool: { __id: "mem-b" } },
    ]);
    expect(customer.calls).toEqual(["mem-a", "mem-b"]);
    // The auth client was acquired and released for the member lookup.
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("throws for an unknown subject", async () => {
    const { pool } = fakeAuthPool(null);
    await expect(
      resolveSubjectPools(pool, "ghost", {
        getCustomerPool: makePoolFactory().fn,
        getGroupPool: makePoolFactory().fn,
      }),
    ).rejects.toThrow(/unknown subject ghost/);
  });

  it("throws when a group subject has no group row", async () => {
    const { pool, client } = fakeAuthPool("group");
    getGroupWithMembersMock.mockResolvedValueOnce(null);
    await expect(
      resolveSubjectPools(pool, "grp-missing", {
        getCustomerPool: makePoolFactory().fn,
        getGroupPool: makePoolFactory().fn,
      }),
    ).rejects.toThrow(/group subject grp-missing has no group row/);
    // The client must still be released on the error path.
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
