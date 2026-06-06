import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { NextRequest } from "next/server";
import type { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  closeAdminPool,
  createTestDatabase,
  dropTestDatabase,
  hasPostgres,
} from "@/lib/db/__tests__/db-test-helpers";
import { runMigrations } from "@/lib/db/migrate";

// ---------------------------------------------------------------------------
// DB-backed integration tests for the analyst management routes.
//
// Unlike the unit suite (which mocks the DB), these drive the *real* route
// handlers against a live PostgreSQL test database so the actual SQL
// (array_agg / unnest / ON CONFLICT / IS DISTINCT FROM) is exercised end to
// end, and the audit gating is validated against real RETURNING results.
// ---------------------------------------------------------------------------

const holder = vi.hoisted(() => ({
  pool: null as Pool | null,
  auditCalls: [] as Array<{
    action: string;
    details?: Record<string, unknown>;
  }>,
}));

const ADMIN_ID = randomUUID();

vi.mock("@/lib/db/client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/db/client")>();
  return { ...actual, getAuthPool: () => holder.pool };
});

vi.mock("@/lib/auth/guards", () => ({
  // biome-ignore lint/complexity/noBannedTypes: test mock needs generic callable
  withAuth: (handler: Function, _opts?: unknown) => (req: NextRequest) =>
    handler(req, {
      accountId: ADMIN_ID,
      sessionId: "sess-1",
      authContext: "admin",
      tokenVersion: 1,
      iat: 1000,
      meta: { ipAddress: "127.0.0.1", userAgent: "test" },
      bridgeAiceId: null,
      bridgeCustomerIds: null,
      audit: {},
    }),
  verifyOrigin: () => null,
  verifyCsrf: () => null,
}));

vi.mock("@/lib/auth/authorization", () => ({
  assertAuthorized: async () => new Set<string>(),
}));

vi.mock("@/lib/audit", () => ({
  auditLog: async (params: {
    action: string;
    details?: Record<string, unknown>;
  }) => {
    holder.auditCalls.push({ action: params.action, details: params.details });
  },
}));

const MIGRATIONS_DIR = join(process.cwd(), "migrations", "auth");
const LOCK_ID = 1041;
const BASE_URL = "http://localhost:3000/api/admin/analysts";

let pool: Pool;
let dbName: string;

async function createAccount(
  status = "active",
  eligible = false,
): Promise<string> {
  const id = randomUUID();
  const suffix = id.slice(0, 8);
  await pool.query(
    `INSERT INTO accounts
       (id, oidc_issuer, oidc_subject, username, display_name, email,
        status, analyst_eligible)
     VALUES ($1, 'iss', $2, $3, $4, $5, $6, $7)`,
    [
      id,
      `sub-${suffix}`,
      `user-${suffix}`,
      `User ${suffix}`,
      `${suffix}@example.com`,
      status,
      eligible,
    ],
  );
  return id;
}

async function createCustomer(status = "active"): Promise<string> {
  const id = randomUUID();
  const suffix = id.slice(0, 8);
  await pool.query(
    `INSERT INTO customers (id, external_key, name, status)
     VALUES ($1, $2, $3, $4)`,
    [id, `ext-${suffix}`, `Customer ${suffix}`, status],
  );
  return id;
}

async function assignmentCount(accountId: string): Promise<number> {
  const r = await pool.query<{ c: string }>(
    `SELECT COUNT(*) AS c FROM analyst_customer_assignments WHERE account_id = $1`,
    [accountId],
  );
  return Number(r.rows[0].c);
}

describe.skipIf(!hasPostgres)("analyst routes (DB)", () => {
  beforeAll(async () => {
    const result = await createTestDatabase("analysts", "auth");
    pool = result.pool;
    dbName = result.dbName;
    holder.pool = pool;
    await runMigrations(pool, MIGRATIONS_DIR, LOCK_ID);
    // The acting admin must exist: assigned_by is a NOT NULL FK to accounts.
    await pool.query(
      `INSERT INTO accounts
         (id, oidc_issuer, oidc_subject, username, display_name, status, admin_eligible)
       VALUES ($1, 'iss', 'admin-sub', 'admin', 'Admin', 'active', true)`,
      [ADMIN_ID],
    );
  });

  beforeEach(() => {
    holder.auditCalls.length = 0;
  });

  afterAll(async () => {
    await dropTestDatabase(dbName, pool, "auth");
    await closeAdminPool();
  });

  it("POST designates an analyst and inserts assignments", async () => {
    const { POST } = await import("../route");
    const account = await createAccount();
    const c1 = await createCustomer();
    const c2 = await createCustomer();

    const res = await POST(
      new NextRequest(new URL(BASE_URL), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account, customerIds: [c1, c2] }),
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.analystEligible).toBe(true);
    expect(new Set(body.assignedCustomerIds)).toEqual(new Set([c1, c2]));
    expect(await assignmentCount(account)).toBe(2);

    const eligibleAudit = holder.auditCalls.filter(
      (a) => a.action === "account.analyst_eligible_changed",
    );
    expect(eligibleAudit).toHaveLength(1);
    expect(eligibleAudit[0].details).toEqual({ from: false, to: true });
    expect(
      holder.auditCalls.filter(
        (a) => a.action === "analyst.assignment.created",
      ),
    ).toHaveLength(2);
  });

  it("POST dedupes customerIds and is idempotent on repeat", async () => {
    const { POST } = await import("../route");
    const account = await createAccount();
    const c1 = await createCustomer();

    function call() {
      return POST(
        new NextRequest(new URL(BASE_URL), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ accountId: account, customerIds: [c1, c1] }),
        }),
      );
    }

    const first = await call();
    expect(first.status).toBe(200);
    expect(await assignmentCount(account)).toBe(1);
    expect(
      holder.auditCalls.filter(
        (a) => a.action === "analyst.assignment.created",
      ),
    ).toHaveLength(1);

    // Repeat: no new rows, no new audit events.
    holder.auditCalls.length = 0;
    const second = await call();
    expect(second.status).toBe(200);
    expect(await assignmentCount(account)).toBe(1);
    expect(holder.auditCalls).toHaveLength(0);
  });

  it("POST returns 400 for a non-active customer (no 500)", async () => {
    const { POST } = await import("../route");
    const account = await createAccount();
    const disabled = await createCustomer("disabled");

    const res = await POST(
      new NextRequest(new URL(BASE_URL), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account, customerIds: [disabled] }),
      }),
    );
    expect(res.status).toBe(400);
    expect(await assignmentCount(account)).toBe(0);
  });

  it("GET lists eligible and revoked-with-assignments accounts", async () => {
    const { GET } = await import("../route");
    const { PATCH } = await import("../[accountId]/route");
    const account = await createAccount();
    const c1 = await createCustomer();
    const { POST } = await import("../route");
    await POST(
      new NextRequest(new URL(BASE_URL), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account, customerIds: [c1] }),
      }),
    );
    // Revoke eligibility but keep the assignment row.
    await PATCH(
      new NextRequest(new URL(`${BASE_URL}/${account}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analystEligible: false }),
      }),
    );

    const res = await GET(
      new NextRequest(new URL(BASE_URL), { method: "GET" }),
    );
    const body = await res.json();
    const found = body.analysts.find(
      (a: { accountId: string }) => a.accountId === account,
    );
    expect(found).toBeDefined();
    expect(found.analystEligible).toBe(false);
    expect(found.assignedCustomerIds).toEqual([c1]);
  });

  it("GET [accountId] returns detail with assignedCustomers; 404 for unknown", async () => {
    const { GET } = await import("../[accountId]/route");
    const { POST } = await import("../route");
    const account = await createAccount();
    const c1 = await createCustomer();
    await POST(
      new NextRequest(new URL(BASE_URL), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account, customerIds: [c1] }),
      }),
    );

    const res = await GET(
      new NextRequest(new URL(`${BASE_URL}/${account}`), { method: "GET" }),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.assignedCustomers).toHaveLength(1);
    expect(body.assignedCustomers[0].id).toBe(c1);
    expect(body.assignedCustomers[0].externalKey).toMatch(/^ext-/);

    const missing = await GET(
      new NextRequest(new URL(`${BASE_URL}/${randomUUID()}`), {
        method: "GET",
      }),
    );
    expect(missing.status).toBe(404);
  });

  it("PATCH revoke works on a suspended account and audits only on change", async () => {
    const { PATCH } = await import("../[accountId]/route");
    const account = await createAccount("suspended", true);

    const res = await PATCH(
      new NextRequest(new URL(`${BASE_URL}/${account}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analystEligible: false }),
      }),
    );
    expect(res.status).toBe(200);
    const row = await pool.query<{ analyst_eligible: boolean }>(
      `SELECT analyst_eligible FROM accounts WHERE id = $1`,
      [account],
    );
    expect(row.rows[0].analyst_eligible).toBe(false);
    expect(
      holder.auditCalls.filter(
        (a) => a.action === "account.analyst_eligible_changed",
      ),
    ).toHaveLength(1);

    // No-op repeat: no audit.
    holder.auditCalls.length = 0;
    await PATCH(
      new NextRequest(new URL(`${BASE_URL}/${account}`), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ analystEligible: false }),
      }),
    );
    expect(holder.auditCalls).toHaveLength(0);
  });

  it("assignment POST adds and DELETE removes, both idempotent", async () => {
    const { POST: ADD } = await import("../[accountId]/assignments/route");
    const { DELETE } = await import(
      "../[accountId]/assignments/[customerId]/route"
    );
    const account = await createAccount();
    const c1 = await createCustomer();

    const addUrl = `${BASE_URL}/${account}/assignments`;
    const addRes = await ADD(
      new NextRequest(new URL(addUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: c1 }),
      }),
    );
    expect(addRes.status).toBe(200);
    expect(await assignmentCount(account)).toBe(1);
    expect(
      holder.auditCalls.filter(
        (a) => a.action === "analyst.assignment.created",
      ),
    ).toHaveLength(1);

    // Idempotent add.
    holder.auditCalls.length = 0;
    await ADD(
      new NextRequest(new URL(addUrl), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: c1 }),
      }),
    );
    expect(await assignmentCount(account)).toBe(1);
    expect(holder.auditCalls).toHaveLength(0);

    // Remove.
    holder.auditCalls.length = 0;
    const delUrl = `${BASE_URL}/${account}/assignments/${c1}`;
    const delRes = await DELETE(
      new NextRequest(new URL(delUrl), { method: "DELETE" }),
    );
    expect(delRes.status).toBe(200);
    expect(await assignmentCount(account)).toBe(0);
    expect(
      holder.auditCalls.filter(
        (a) => a.action === "analyst.assignment.removed",
      ),
    ).toHaveLength(1);

    // Idempotent delete: 200, no audit, even for an unknown account id.
    holder.auditCalls.length = 0;
    const ghost = await DELETE(
      new NextRequest(
        new URL(`${BASE_URL}/${randomUUID()}/assignments/${randomUUID()}`),
        { method: "DELETE" },
      ),
    );
    expect(ghost.status).toBe(200);
    expect(holder.auditCalls).toHaveLength(0);
  });

  it("assignment POST returns 404 for unknown account before INSERT", async () => {
    const { POST: ADD } = await import("../[accountId]/assignments/route");
    const c1 = await createCustomer();
    const res = await ADD(
      new NextRequest(new URL(`${BASE_URL}/${randomUUID()}/assignments`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ customerId: c1 }),
      }),
    );
    expect(res.status).toBe(404);
  });
});
