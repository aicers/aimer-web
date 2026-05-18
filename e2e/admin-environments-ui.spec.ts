import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { Pool } from "pg";
import { expect, getTestPool, test } from "./fixtures";

// ---------------------------------------------------------------------------
// E2E UI tests for the admin environments page — covers acceptance criteria
// from issue #192 (JWK Thumbprint confirm flow) and issue #193 (expires_at
// soft-expiry policy) that the unit + component tests cannot exercise.
//
// The cache hard-expiry regression (warm cache → advance clock past
// expires_at → reject without a second DB load) stays at the unit layer:
// see src/lib/auth/__tests__/trust-registry.unit.test.ts:213.
// ---------------------------------------------------------------------------

// All aice_ids the suite creates — cleaned up in afterAll regardless of
// pass/fail so a flaky test cannot leak rows into the shared dev DB.
const createdAiceIds: string[] = [];

function uniqueAiceId(prefix: string): string {
  const id = `${prefix}-${randomUUID().slice(0, 8)}`;
  createdAiceIds.push(id);
  return id;
}

// Distinct `n` values produce distinct thumbprints, so each test gets a fresh
// JWK rather than sharing a thumbprint across tests. `jose.calculateJwkThumbprint`
// accepts any RSA shape with `n` + `e`; the values do not need to be a real key.
function rsaJwk(salt: string): { kty: "RSA"; n: string; e: string } {
  return {
    kty: "RSA",
    n: `e2e-jwk-${salt}-${randomUUID().slice(0, 12)}`,
    e: "AQAB",
  };
}

async function openAuditPool(): Promise<Pool> {
  const url =
    process.env.AUDIT_DATABASE_MIGRATION_URL ?? process.env.AUDIT_DATABASE_URL;
  if (!url) throw new Error("AUDIT_DATABASE_URL is required for E2E");
  return new Pool({ connectionString: url });
}

// Audit rows are written via fire-and-forget `void auditLog(...)` (see
// src/app/api/admin/environments/route.ts:328 and src/lib/auth/guards.ts:206),
// so the row may not be committed by the time the UI action settles. Poll
// the audit DB until a matching row appears (or fail loudly after a budget).
async function waitForAuditRow<R extends Record<string, unknown>>(
  pool: Pool,
  sql: string,
  params: unknown[],
  predicate: (row: R) => boolean = () => true,
  timeoutMs = 5_000,
): Promise<R> {
  const deadline = Date.now() + timeoutMs;
  let lastRow: R | undefined;
  while (Date.now() < deadline) {
    const result = await pool.query<R>(sql, params);
    const match = result.rows.find(predicate);
    if (match) return match;
    lastRow = result.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for audit row matching predicate. Last row seen: ${
      lastRow ? JSON.stringify(lastRow) : "<none>"
    }`,
  );
}

test.afterAll(async () => {
  if (createdAiceIds.length === 0) return;

  const pool = getTestPool();
  await pool.query("DELETE FROM trust_registry WHERE aice_id = ANY($1)", [
    createdAiceIds,
  ]);
  await pool.query("DELETE FROM aice_environments WHERE aice_id = ANY($1)", [
    createdAiceIds,
  ]);

  const auditPool = await openAuditPool();
  try {
    await auditPool.query("DELETE FROM audit_logs WHERE aice_id = ANY($1)", [
      createdAiceIds,
    ]);
    // Bridge-verify denial rows for the unverified-context-token case carry
    // `aiceId` only inside the JSONB `details` payload (the column is NULL),
    // so they need a separate cleanup pass keyed off the JSONB field.
    await auditPool.query(
      "DELETE FROM audit_logs WHERE action = 'bridge.connection_denied' AND details->>'aiceId' = ANY($1)",
      [createdAiceIds],
    );
  } finally {
    await auditPool.end();
  }
});

// ---------------------------------------------------------------------------
// Helpers — page navigation
// ---------------------------------------------------------------------------

// The toolbar buttons "Create Environment" / "Register Key" share the
// accessible name of their respective dialog submit buttons, so submit
// locators are always scoped to the open dialog via this helper to avoid
// strict-mode collisions.
function openDialog(adminPage: Page, title: string) {
  return adminPage.locator('[role="dialog"]').filter({
    has: adminPage.getByRole("heading", { name: title, exact: true }),
  });
}

async function openCreateEnvDialog(adminPage: Page): Promise<void> {
  await adminPage.goto("/en/admin/environments");
  await expect(
    adminPage.getByRole("heading", { name: "Create Environment" }),
  ).toHaveCount(0);
  await adminPage
    .getByRole("button", { name: "Create Environment", exact: true })
    .click();
  await expect(
    adminPage.getByRole("heading", { name: "Create Environment" }),
  ).toBeVisible();
}

async function openKeysTab(adminPage: Page, aiceId: string): Promise<void> {
  await adminPage.goto("/en/admin/environments");
  const row = adminPage.locator("tbody tr", { hasText: aiceId });
  await row.waitFor();
  // Each row exposes a Keys-count button; clicking it opens the detail panel
  // pre-selected on the keys tab (see environments-page.tsx openDetail()).
  await row.getByRole("button", { name: /^\d+$/ }).nth(1).click();
  await expect(
    adminPage.getByRole("heading", { name: "Trust Registry Keys" }),
  ).toBeVisible();
}

async function openRegisterKeyDialog(
  adminPage: Page,
  aiceId: string,
): Promise<void> {
  await openKeysTab(adminPage, aiceId);
  // The toolbar "Register Key" is the only one visible before the dialog
  // opens, so it can be matched directly without dialog scoping.
  await adminPage
    .getByRole("button", { name: "Register Key", exact: true })
    .click();
  await expect(
    adminPage.getByRole("heading", { name: "Register Key" }),
  ).toBeVisible();
}

// Seeds an environment via direct DB insert so that tests focused on the
// per-environment "Register key" / keys-tab flow don't depend on a prior
// create-flow test passing.
async function seedEnvironment(name?: string): Promise<{
  aiceId: string;
  name: string;
}> {
  const aiceId = uniqueAiceId("env");
  const envName = name ?? `E2E ${aiceId}`;
  const pool = getTestPool();
  await pool.query(
    "INSERT INTO aice_environments (aice_id, name, status) VALUES ($1, $2, 'active')",
    [aiceId, envName],
  );
  return { aiceId, name: envName };
}

// ---------------------------------------------------------------------------
// JWK Thumbprint confirm scenarios (issue #192)
// ---------------------------------------------------------------------------

test.describe("Admin environments — JWK Thumbprint confirm flow", () => {
  // The register-key flow on the keys tab chains a goto, two row-button
  // clicks, a thumbprint API round-trip, and a submit POST — under CI load
  // the cumulative wall-clock can push past the default 30 s test budget.
  test.describe.configure({ timeout: 60_000 });

  test("environment-creation path renders thumbprint, gates submit on confirmation", async ({
    adminPage,
  }) => {
    const aiceId = uniqueAiceId("env");
    const jwk = rsaJwk("create");

    await openCreateEnvDialog(adminPage);

    await adminPage.locator("#env-aice-id").fill(aiceId);
    await adminPage.locator("#env-name").fill(`E2E ${aiceId}`);

    // Enable the optional trust-registry-key sub-form.
    await adminPage
      .getByRole("checkbox", { name: /Trust Registry Key/ })
      .check();

    await adminPage.locator("#env-issuer").fill("https://issuer.example");
    await adminPage.locator("#env-kid").fill("key-1");
    await adminPage
      .locator("#env-public-key")
      .fill(JSON.stringify(jwk, null, 2));

    // Thumbprint renders untruncated in both formats once /api/admin/trust-registry/thumbprint resolves.
    const dialog = openDialog(adminPage, "Create Environment");
    const base64Block = dialog
      .locator("code", { hasText: /^[A-Za-z0-9_-]{43}$/ })
      .first();
    await expect(base64Block).toBeVisible();
    const base64Value = (await base64Block.textContent())?.trim() ?? "";
    expect(base64Value).toHaveLength(43); // RFC 7638 SHA-256 → 43 base64url chars

    const hexBlock = dialog
      .locator("code", { hasText: /^[0-9a-f]{8}(?::[0-9a-f]{8}){7}$/ })
      .first();
    await expect(hexBlock).toBeVisible();

    // Submit stays disabled until the operator toggles the confirm checkbox.
    const submitBtn = dialog.getByRole("button", {
      name: "Create Environment",
      exact: true,
    });
    await expect(submitBtn).toBeDisabled();

    const confirmCheckbox = dialog.getByRole("checkbox", {
      name: /I confirmed the thumbprint/,
    });
    await confirmCheckbox.check();
    await expect(submitBtn).toBeEnabled();

    await submitBtn.click();

    // Wait for the dialog to close, indicating the POST succeeded.
    await expect(
      adminPage.getByRole("heading", { name: "Create Environment" }),
    ).toBeHidden();

    // Submitted environment + trust_registry row exist.
    const pool = getTestPool();
    const envRow = await pool.query(
      "SELECT aice_id FROM aice_environments WHERE aice_id = $1",
      [aiceId],
    );
    expect(envRow.rowCount).toBe(1);
    const keyRow = await pool.query(
      "SELECT id, issuer, kid FROM trust_registry WHERE aice_id = $1",
      [aiceId],
    );
    expect(keyRow.rowCount).toBe(1);
    expect(keyRow.rows[0]).toMatchObject({
      issuer: "https://issuer.example",
      kid: "key-1",
    });

    // Audit log records the server-computed thumbprint. Polled because the
    // route writes the row via `void auditLog(...)`.
    const auditPool = await openAuditPool();
    try {
      const row = await waitForAuditRow<{ details: Record<string, unknown> }>(
        auditPool,
        `SELECT details FROM audit_logs
         WHERE aice_id = $1 AND action = 'trust_registry.key_registered'`,
        [aiceId],
      );
      expect(row.details.jwkThumbprint).toBe(base64Value);
    } finally {
      await auditPool.end();
    }
  });

  test("existing-environment Register key path renders thumbprint, gates submit", async ({
    adminPage,
  }) => {
    const env = await seedEnvironment();
    const jwk = rsaJwk("register");

    await openRegisterKeyDialog(adminPage, env.aiceId);

    await adminPage.locator("#reg-issuer").fill("https://issuer.example");
    await adminPage.locator("#reg-kid").fill("key-reg-1");
    await adminPage.locator("#reg-public-key").fill(JSON.stringify(jwk));

    const dialog = openDialog(adminPage, "Register Key");
    const base64Block = dialog
      .locator("code", { hasText: /^[A-Za-z0-9_-]{43}$/ })
      .first();
    await expect(base64Block).toBeVisible();

    const submitBtn = dialog.getByRole("button", {
      name: "Register Key",
      exact: true,
    });
    await expect(submitBtn).toBeDisabled();

    await dialog
      .getByRole("checkbox", { name: /I confirmed the thumbprint/ })
      .check();
    await expect(submitBtn).toBeEnabled();
    await submitBtn.click();

    await expect(
      adminPage.getByRole("heading", { name: "Register Key" }),
    ).toBeHidden();

    const pool = getTestPool();
    const keyRow = await pool.query(
      "SELECT issuer, kid FROM trust_registry WHERE aice_id = $1",
      [env.aiceId],
    );
    expect(keyRow.rowCount).toBe(1);
    expect(keyRow.rows[0]).toMatchObject({
      issuer: "https://issuer.example",
      kid: "key-reg-1",
    });
  });

  test("changing the JWK textarea clears confirmation, hides thumbprint, re-disables submit", async ({
    adminPage,
  }) => {
    const env = await seedEnvironment();
    const jwkA = rsaJwk("reset-a");
    const jwkB = rsaJwk("reset-b");

    await openRegisterKeyDialog(adminPage, env.aiceId);

    await adminPage.locator("#reg-issuer").fill("https://issuer.example");
    await adminPage.locator("#reg-kid").fill("key-reset");
    await adminPage.locator("#reg-public-key").fill(JSON.stringify(jwkA));

    const dialog = openDialog(adminPage, "Register Key");
    const thumbprintBlock = dialog
      .locator("code", { hasText: /^[A-Za-z0-9_-]{43}$/ })
      .first();
    await expect(thumbprintBlock).toBeVisible();
    const valueA = (await thumbprintBlock.textContent())?.trim() ?? "";

    const confirmCheckbox = dialog.getByRole("checkbox", {
      name: /I confirmed the thumbprint/,
    });
    await confirmCheckbox.check();

    const submitBtn = dialog.getByRole("button", {
      name: "Register Key",
      exact: true,
    });
    await expect(submitBtn).toBeEnabled();

    // Replace the JWK input — confirmation should clear, thumbprint should
    // hide, and submit should re-disable. Re-pasting a (different) valid JWK
    // shows the new thumbprint and again requires fresh confirmation.
    await adminPage.locator("#reg-public-key").fill(JSON.stringify(jwkB));

    await expect(confirmCheckbox).not.toBeChecked();
    await expect(submitBtn).toBeDisabled();

    await expect(thumbprintBlock).toBeVisible();
    const valueB = (await thumbprintBlock.textContent())?.trim() ?? "";
    expect(valueB).not.toBe(valueA);

    // Fresh confirmation required.
    await confirmCheckbox.check();
    await expect(submitBtn).toBeEnabled();
  });

  test("invalid JWK (unsupported kty) shows error, hides confirm UI, keeps submit disabled", async ({
    adminPage,
  }) => {
    const env = await seedEnvironment();

    await openRegisterKeyDialog(adminPage, env.aiceId);

    await adminPage.locator("#reg-issuer").fill("https://issuer.example");
    await adminPage.locator("#reg-kid").fill("key-invalid");
    await adminPage
      .locator("#reg-public-key")
      .fill(JSON.stringify({ kty: "BOGUS" }));

    // Error renders; thumbprint never shows; confirm UI is not present.
    const dialog = openDialog(adminPage, "Register Key");
    await expect(dialog.getByText(/Invalid JWK/)).toBeVisible();
    await expect(
      dialog.locator("code", { hasText: /^[A-Za-z0-9_-]{43}$/ }),
    ).toHaveCount(0);
    await expect(
      dialog.getByRole("checkbox", {
        name: /I confirmed the thumbprint/,
      }),
    ).toHaveCount(0);

    await expect(
      dialog.getByRole("button", { name: "Register Key", exact: true }),
    ).toBeDisabled();

    // No DB row written.
    const pool = getTestPool();
    const keyRow = await pool.query(
      "SELECT id FROM trust_registry WHERE aice_id = $1",
      [env.aiceId],
    );
    expect(keyRow.rowCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// expires_at lifecycle scenarios (issue #193)
// ---------------------------------------------------------------------------

test.describe("Admin environments — trust_registry expires_at", () => {
  // Two of these scenarios loop the register-key flow three times each
  // (open dialog → fill → thumbprint round-trip → submit) which exceeds the
  // default 30 s test timeout under CI load.
  test.describe.configure({ timeout: 90_000 });

  test("accepts valid Z and +09:00 forms, persists canonical UTC; empty → NULL", async ({
    adminPage,
  }) => {
    const env = await seedEnvironment();
    const pool = getTestPool();

    async function registerKey(
      kid: string,
      jwk: ReturnType<typeof rsaJwk>,
      expiresAtInput: string,
    ) {
      await openRegisterKeyDialog(adminPage, env.aiceId);
      const dialog = openDialog(adminPage, "Register Key");
      await adminPage.locator("#reg-issuer").fill("https://issuer.example");
      await adminPage.locator("#reg-kid").fill(kid);
      await adminPage.locator("#reg-public-key").fill(JSON.stringify(jwk));
      await expect(
        dialog.locator("code", { hasText: /^[A-Za-z0-9_-]{43}$/ }).first(),
      ).toBeVisible();
      if (expiresAtInput) {
        await adminPage.locator("#reg-key-expires-at").fill(expiresAtInput);
      }
      await dialog
        .getByRole("checkbox", { name: /I confirmed the thumbprint/ })
        .check();
      await dialog
        .getByRole("button", { name: "Register Key", exact: true })
        .click();
      await expect(
        adminPage.getByRole("heading", { name: "Register Key" }),
      ).toBeHidden();
    }

    // 1. valid Z form
    await registerKey("kid-utc", rsaJwk("utc"), "2030-05-05T12:00:00Z");
    // 2. valid +09:00 form — same instant as 2030-05-05T03:00:00Z
    await registerKey("kid-kst", rsaJwk("kst"), "2030-05-05T12:00:00+09:00");
    // 3. empty / omitted → NULL (soft-expiry)
    await registerKey("kid-soft", rsaJwk("soft"), "");

    const rows = await pool.query<{
      kid: string;
      expires_at: Date | null;
    }>(
      `SELECT kid, expires_at FROM trust_registry
       WHERE aice_id = $1 ORDER BY kid`,
      [env.aiceId],
    );
    const byKid = Object.fromEntries(
      rows.rows.map((r) => [r.kid, r.expires_at]),
    );
    expect(byKid["kid-utc"]).toEqual(new Date("2030-05-05T12:00:00.000Z"));
    expect(byKid["kid-kst"]).toEqual(new Date("2030-05-05T03:00:00.000Z"));
    expect(byKid["kid-soft"]).toBeNull();

    // The soft-expiry row's UI reflects "no expiry".
    await openKeysTab(adminPage, env.aiceId);
    const softRow = adminPage.locator("tbody tr", { hasText: "kid-soft" });
    await expect(softRow).toContainText("No expiry (soft)");
  });

  test("rejects timezone-less, date-only, and out-of-range calendar inputs", async ({
    adminPage,
  }) => {
    const env = await seedEnvironment();

    const cases = [
      "2030-05-05T12:00:00", // timezone-less
      "2030-05-05", // date-only
      "2026-02-30T00:00:00Z", // out-of-range calendar
    ];

    for (const [index, value] of cases.entries()) {
      await openRegisterKeyDialog(adminPage, env.aiceId);
      const dialog = openDialog(adminPage, "Register Key");
      await adminPage.locator("#reg-issuer").fill("https://issuer.example");
      await adminPage.locator("#reg-kid").fill(`kid-${index}`);
      await adminPage
        .locator("#reg-public-key")
        .fill(JSON.stringify(rsaJwk(value)));
      await expect(
        dialog.locator("code", { hasText: /^[A-Za-z0-9_-]{43}$/ }).first(),
      ).toBeVisible();
      await adminPage.locator("#reg-key-expires-at").fill(value);
      await dialog
        .getByRole("checkbox", { name: /I confirmed the thumbprint/ })
        .check();
      await dialog
        .getByRole("button", { name: "Register Key", exact: true })
        .click();

      // Error toast surfaces the invalid-format message; the dialog stays open.
      await expect(
        adminPage.getByText(
          /Expires At must be a timezone-explicit ISO 8601 datetime\./,
        ),
      ).toBeVisible();
      await expect(
        adminPage.getByRole("heading", { name: "Register Key" }),
      ).toBeVisible();

      // Close the dialog so the next iteration starts clean.
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(
        adminPage.getByRole("heading", { name: "Register Key" }),
      ).toBeHidden();
    }

    // No rows written for any of the invalid inputs.
    const pool = getTestPool();
    const keys = await pool.query(
      "SELECT id FROM trust_registry WHERE aice_id = $1",
      [env.aiceId],
    );
    expect(keys.rowCount).toBe(0);
  });

  test("per-key row color signals reflect classifyExpiry thresholds", async ({
    adminPage,
  }) => {
    const env = await seedEnvironment();
    const pool = getTestPool();

    // Seed three keys via direct DB insert so the test isolates the
    // classifyExpiry → row class wiring (the threshold logic itself is
    // unit-covered by expiry-status.unit.test.ts). Each key carries a
    // distinctive kid so the test can address rows individually. The
    // admin-UI/API acceptance path for a past `expires_at` and the
    // bridge-verify reject behaviour live in the next test.
    const now = Date.now();
    const inDays = (n: number) => new Date(now + n * 24 * 60 * 60 * 1000);
    await pool.query(
      `INSERT INTO trust_registry (aice_id, issuer, kid, public_key, expires_at)
       VALUES
         ($1, 'iss', 'kid-yellow', '{}'::jsonb, $2),
         ($1, 'iss', 'kid-red',    '{}'::jsonb, $3),
         ($1, 'iss', 'kid-expired','{}'::jsonb, $4)`,
      [env.aiceId, inDays(20), inDays(3), inDays(-1)],
    );

    await openKeysTab(adminPage, env.aiceId);

    const yellowExpiry = adminPage
      .locator("tbody tr", { hasText: "kid-yellow" })
      .locator(".text-amber-600, .dark\\:text-amber-400");
    await expect(yellowExpiry).toBeVisible();

    const redExpiry = adminPage
      .locator("tbody tr", { hasText: "kid-red" })
      .locator(".text-destructive");
    await expect(redExpiry).toBeVisible();

    const expiredRow = adminPage.locator("tbody tr", {
      hasText: "kid-expired",
    });
    await expect(expiredRow).toContainText("expired");
    // The expired row's status text uses `text-xs text-muted-foreground` (the
    // gray-after-expiry signal). Scope to that exact class pair to avoid
    // matching the kid cell or the date-suffix span, which also use the
    // muted-foreground colour for unrelated reasons.
    await expect(
      expiredRow.locator(".text-xs.text-muted-foreground"),
    ).toBeVisible();
  });

  test("past expires_at accepted via admin UI; bridge verify rejects with trust_registry_key_expired audit reason", async ({
    adminPage,
  }) => {
    const env = await seedEnvironment();
    const pool = getTestPool();

    // jose is ESM-only — match the dynamic-import convention used by
    // e2e/fixtures/auth.ts.
    const jose = await import("jose");
    const kp = await jose.generateKeyPair("ES256", { extractable: true });
    const publicJwk = await jose.exportJWK(kp.publicKey);

    const issuer = `https://issuer-${randomUUID().slice(0, 8)}.example`;
    const kid = `kid-past-${randomUUID().slice(0, 8)}`;
    // "Burn" / emergency-revocation case from #193: the operator deliberately
    // submits an `expires_at` that is already in the past. The admin form has
    // no past-date guard (parseExpiresAtInput documents that past timestamps
    // are accepted on purpose), so this exercises the real submit path.
    const pastExpiry = "2020-01-01T00:00:00Z";

    await openRegisterKeyDialog(adminPage, env.aiceId);
    const dialog = openDialog(adminPage, "Register Key");
    await adminPage.locator("#reg-issuer").fill(issuer);
    await adminPage.locator("#reg-kid").fill(kid);
    await adminPage.locator("#reg-public-key").fill(JSON.stringify(publicJwk));
    await expect(
      dialog.locator("code", { hasText: /^[A-Za-z0-9_-]{43}$/ }).first(),
    ).toBeVisible();
    await adminPage.locator("#reg-key-expires-at").fill(pastExpiry);
    await dialog
      .getByRole("checkbox", { name: /I confirmed the thumbprint/ })
      .check();
    await dialog
      .getByRole("button", { name: "Register Key", exact: true })
      .click();
    // Dialog closes only on a 2xx response — proves the admin API accepted
    // the past timestamp.
    await expect(
      adminPage.getByRole("heading", { name: "Register Key" }),
    ).toBeHidden();

    const keyRow = await pool.query<{ expires_at: Date | null }>(
      "SELECT expires_at FROM trust_registry WHERE aice_id = $1 AND kid = $2",
      [env.aiceId, kid],
    );
    expect(keyRow.rowCount).toBe(1);
    expect(keyRow.rows[0].expires_at).toEqual(new Date(pastExpiry));

    // Sign a context_token with the matching private key. The bridge verify
    // path will look up the registered JWK by (aice_id, iss, kid), find it
    // expired, and reject without ever validating the signature.
    const jti = randomUUID();
    const token = await new jose.SignJWT({
      aice_id: env.aiceId,
      customer_ids: [],
    })
      .setProtectedHeader({ alg: "ES256", kid })
      .setSubject(`e2e-bridge-${jti}`)
      .setJti(jti)
      .setIssuer(issuer)
      .setAudience("aimer-web")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(kp.privateKey);

    const res = await adminPage.request.post("/api/auth/bridge", {
      multipart: { context_token: token },
      maxRedirects: 0,
    });
    expect(res.status()).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid context token");

    // The bridge route emits this audit row with no top-level `aiceId` because
    // the context token failed verification before claims were extracted (see
    // src/app/api/auth/bridge/route.ts trust_registry_key_expired branch with
    // `!claims`). The `aice_id` column is therefore NULL — the only
    // identifying field is `details.aiceId`, taken from the unverified payload.
    const auditPool = await openAuditPool();
    try {
      const row = await waitForAuditRow<{
        details: {
          reason?: string;
          innerReason?: string;
          aiceId?: string;
          kid?: string;
          issuer?: string;
        };
      }>(
        auditPool,
        `SELECT details FROM audit_logs
         WHERE action = 'bridge.connection_denied'
           AND details->>'aiceId' = $1
           AND details->>'innerReason' = 'trust_registry_key_expired'
         ORDER BY id DESC`,
        [env.aiceId],
      );
      expect(row.details.reason).toBe("context_token_rejected");
      expect(row.details.kid).toBe(kid);
      expect(row.details.issuer).toBe(issuer);
      expect(row.details.aiceId).toBe(env.aiceId);
    } finally {
      await auditPool.end();
    }
  });
});
