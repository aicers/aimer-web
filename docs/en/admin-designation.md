# System Admin Designation

The Admins page lets existing System Admins designate or revoke
other System Admins. Navigate to **Admins** in the admin sidebar
to open it.

Only System Admins with the `accounts:write` permission can
designate or revoke admins. The `accounts:read` permission is
required to view the current list.

The system enforces a maximum of **3 System Admins** at any time.

![Admins page](../assets/admin-admins-table.png)

## Admin table

The table lists all current System Admins. Each row shows:

- **Name** — the admin's display name and username. Your own row
    is tagged with a "(you)" label.
- **Email** — the admin's email address.
- **Status** — one of Active, Suspended, or Disabled.
- **Last Sign-In** — the date and time of the most recent
    sign-in, or "Never" if the admin has not signed in.
- **Actions** — a Revoke button (not shown for your own account).

A counter above the table shows how many admin slots are in use
(e.g., "2 of 3 admin slots used").

## Designating a new admin

1. Click the **Designate Admin** button above the table.
2. A dialog appears with a dropdown of eligible accounts
    (active, non-admin accounts).
3. Select the account to designate.
4. Click **Designate Admin** to confirm.

![Designate admin dialog](../assets/admin-admins-designate-dialog.png)

When an account is designated as System Admin:

- The `admin_eligible` flag is set to `true` in the database.
- The `aimer_admin` realm role is assigned in Keycloak.
- The account can now sign in to the admin portal with MFA.

The Designate Admin button is disabled when:

- The maximum of 3 admins has been reached.
- No eligible accounts are available.

## Revoking an admin

1. Find the admin you want to revoke in the table.
2. Click the **Revoke** button in the Actions column.
3. A confirmation dialog warns that all admin sessions will be
    terminated immediately.
4. Click **Revoke** to confirm.

![Revoke admin dialog](../assets/admin-admins-revoke-dialog.png)

When admin privileges are revoked:

- The `admin_eligible` flag is set to `false` in the database.
- All active admin sessions are revoked immediately.
- Any in-flight admin JWTs are rejected because `admin_eligible`
    is now `false` (checked by `verifyJwtFull` on every request).
- General (non-admin) sessions remain unaffected.
- The `aimer_admin` realm role is removed from Keycloak.
- The account can no longer access the admin portal.

Admins cannot revoke their own admin privileges. The Revoke
button is not shown for your own row.

## First System Admin bootstrap

The first System Admin must be bootstrapped manually because
there is no existing admin to perform the designation through
the UI.

1. **Assign the Keycloak realm role**: Open the Keycloak admin
    console, navigate to **Users**, find the target user, go to
    the **Role Mappings** tab, and assign the `aimer_admin`
    realm role.

2. **Set the database flag**: Connect to the `auth_db` database
    and run:

        UPDATE accounts
        SET admin_eligible = true, updated_at = NOW()
        WHERE username = '<target-username>';

After completing both steps, the user can sign in to the admin
portal at `/admin` with MFA enabled.

## Keycloak service account setup

The admin designation and revocation endpoints use a Keycloak
service account to assign and remove the `aimer_admin` realm role.
This service account is separate from the OIDC clients used for
user authentication.

1. In the Keycloak admin console, create a new **confidential**
    client (e.g., `aimer-admin-sa`).
2. Enable **Service Account Enabled** on the client.
3. Under the **Service Account Roles** tab, assign the
    `realm-admin` role (from the `realm-management` client) so the
    service account can manage realm role mappings.
4. Copy the client ID and secret to your environment:

        KEYCLOAK_ADMIN_CLIENT_ID=aimer-admin-sa
        KEYCLOAK_ADMIN_CLIENT_SECRET=<generated-secret>

Do **not** use the built-in `admin-cli` client — it does not
support the `client_credentials` grant by default.

## Concurrency safety

The 3-admin limit is enforced with a PostgreSQL advisory lock
(`pg_advisory_xact_lock`) that serializes all designation
requests. This prevents race conditions when two admins
simultaneously attempt to designate a new admin.
