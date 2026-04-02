# Account Management

The Accounts page lets System Admins view and manage all user
accounts in the system. Navigate to **Accounts** in the admin
sidebar to open it.

Only System Admins with the `accounts:read` permission can view
this page. The `accounts:write` permission is required to
suspend or unsuspend accounts.

![Accounts page](../assets/admin-accounts-table.png)

## Account table

The table lists all accounts in the system. Each row shows:

- **Name** — the account's display name and username. Your own
    row is tagged with a "(you)" label.
- **Email** — the account's email address.
- **Status** — one of Active, Suspended, or Disabled.
- **Admin** — whether the account is eligible for System Admin
    access.
- **Analyst** — whether the account is eligible for the Analyst
    role.
- **Last Sign-In** — the date and time of the most recent
    sign-in, or "Never" if the account has not signed in.
- **Actions** — suspend or unsuspend buttons (not shown for
    your own account).

## Suspending an account

1. Find the account you want to suspend in the table.
2. Click the **Suspend** button in the Actions column.
3. A confirmation dialog appears warning that all active
    sessions will be terminated immediately.
4. Click **Suspend** to confirm.

![Suspend confirmation dialog](../assets/admin-accounts-suspend-dialog.png)

When an account is suspended:

- All active sessions (both general and admin) are revoked
    immediately.
- Any in-flight JWT tokens are invalidated by incrementing the
    account's token version.
- The account cannot sign in until it is unsuspended.
- The status badge changes to **Suspended** (red).

Admins cannot suspend their own account. The Suspend button is
not shown for your own row.

## Unsuspending an account

1. Find the suspended account in the table.
2. Click the **Unsuspend** button in the Actions column.
3. A confirmation dialog appears.
4. Click **Unsuspend** to confirm.

The account returns to **Active** status and the user can sign
in again.

## Audit trail

Every suspend and unsuspend action is recorded in the audit
log. The audit entries include:

- **account.suspended** — when an account is suspended.
- **account.restored** — when a suspended account is
    unsuspended.

Both entries record the actor, target account, previous status,
and new status. View these entries on the
[Audit Logs](audit-logs.md) page.
