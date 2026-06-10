// Unit tests for listAccessibleGroups (#513).
//
// The function filters every group down to those where the viewer holds
// `reports:read` on EVERY member, using the shared `computeMemberAccess` grant
// union. Both dependencies are mocked so the predicate is exercised in
// isolation (the SQL itself is covered by the db test).

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListGroups = vi.fn();
const mockComputeAccess = vi.fn();

vi.mock("@/lib/groups/groups", () => ({
  listGroupsWithMembers: (...a: unknown[]) => mockListGroups(...a),
}));
vi.mock("@/lib/auth/authorization", () => ({
  computeMemberAccess: (...a: unknown[]) => mockComputeAccess(...a),
}));

import {
  listAccessibleGroups,
  listManageableGroups,
} from "../group-authorization";

function access(entries: Record<string, string[]>) {
  const m = new Map<string, { permissions: Set<string> }>();
  for (const [id, perms] of Object.entries(entries)) {
    m.set(id, { permissions: new Set(perms) });
  }
  return m;
}

// biome-ignore lint/suspicious/noExplicitAny: PoolClient is unused (deps mocked)
const client = {} as any;

describe("listAccessibleGroups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps only groups where reports:read is held on every member", async () => {
    mockListGroups.mockResolvedValue([
      {
        group: { id: "g1", name: "Alpha", description: "a", tz: "UTC" },
        memberIds: ["c1", "c2"],
      },
      {
        group: { id: "g2", name: "Beta", description: null, tz: "UTC" },
        memberIds: ["c2", "c3"],
      },
    ]);
    // Viewer has reports:read on c1, c2 but NOT c3 → g1 visible, g2 dropped.
    mockComputeAccess.mockResolvedValue(
      access({
        c1: ["reports:read"],
        c2: ["reports:read", "analyses:read"],
        c3: ["analyses:read"],
      }),
    );

    const groups = await listAccessibleGroups(client, "acct-1");
    expect(groups).toEqual([
      {
        id: "g1",
        name: "Alpha",
        description: "a",
        memberIds: ["c1", "c2"],
        tz: "UTC",
      },
    ]);
  });

  it("drops a group inaccessible on even one member (existence-hiding)", async () => {
    mockListGroups.mockResolvedValue([
      {
        group: { id: "g1", name: "Alpha", description: null, tz: "UTC" },
        memberIds: ["c1", "c2"],
      },
    ]);
    // c2 absent from the access map (non-member) → group hidden.
    mockComputeAccess.mockResolvedValue(access({ c1: ["reports:read"] }));

    expect(await listAccessibleGroups(client, "acct-1")).toEqual([]);
  });

  it("never lists a member-less group", async () => {
    mockListGroups.mockResolvedValue([
      {
        group: { id: "g1", name: "Empty", description: null, tz: "UTC" },
        memberIds: [],
      },
    ]);
    mockComputeAccess.mockResolvedValue(access({}));

    expect(await listAccessibleGroups(client, "acct-1")).toEqual([]);
  });

  it("short-circuits with no groups at all", async () => {
    mockListGroups.mockResolvedValue([]);
    expect(await listAccessibleGroups(client, "acct-1")).toEqual([]);
    expect(mockComputeAccess).not.toHaveBeenCalled();
  });
});

// Builds an access map carrying role / isAnalyst, the facts the management
// predicate reads (distinct from the reports:read permission set above).
function manageAccess(
  entries: Record<string, { role?: string | null; isAnalyst?: boolean }>,
) {
  const m = new Map<
    string,
    { role: string | null; isAnalyst: boolean; permissions: Set<string> }
  >();
  for (const [id, v] of Object.entries(entries)) {
    m.set(id, {
      role: v.role ?? null,
      isAnalyst: v.isAnalyst ?? false,
      permissions: new Set(),
    });
  }
  return m;
}

describe("listManageableGroups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps only groups manageable (Manager or Analyst) on every member", async () => {
    mockListGroups.mockResolvedValue([
      {
        group: {
          id: "g1",
          name: "Alpha",
          ownerId: "acct-1",
          createdBy: "acct-1",
          databaseStatus: "active",
        },
        memberIds: ["c1", "c2"],
      },
      {
        group: {
          id: "g2",
          name: "Beta",
          ownerId: "acct-9",
          createdBy: "acct-9",
          databaseStatus: "failed",
        },
        memberIds: ["c2", "c3"],
      },
    ]);
    // Manager on c1, Analyst on c2, but only "User" on c3 → g1 manageable,
    // g2 dropped (a viewable-but-not-manageable member fails the gate).
    mockComputeAccess.mockResolvedValue(
      manageAccess({
        c1: { role: "Manager" },
        c2: { isAnalyst: true },
        c3: { role: "User" },
      }),
    );

    const groups = await listManageableGroups(client, "acct-1");
    expect(groups).toEqual([
      {
        id: "g1",
        name: "Alpha",
        memberCount: 2,
        databaseStatus: "active",
        ownerId: "acct-1",
        createdBy: "acct-1",
      },
    ]);
  });

  it("drops a group with a non-member (absent from the access map)", async () => {
    mockListGroups.mockResolvedValue([
      {
        group: {
          id: "g1",
          name: "Alpha",
          ownerId: "acct-1",
          createdBy: "acct-1",
          databaseStatus: "active",
        },
        memberIds: ["c1", "c2"],
      },
    ]);
    mockComputeAccess.mockResolvedValue(
      manageAccess({ c1: { role: "Manager" } }),
    );

    expect(await listManageableGroups(client, "acct-1")).toEqual([]);
  });

  it("never lists a member-less group", async () => {
    mockListGroups.mockResolvedValue([
      {
        group: {
          id: "g1",
          name: "Empty",
          ownerId: "acct-1",
          createdBy: "acct-1",
          databaseStatus: "active",
        },
        memberIds: [],
      },
    ]);
    mockComputeAccess.mockResolvedValue(manageAccess({}));

    expect(await listManageableGroups(client, "acct-1")).toEqual([]);
  });
});
