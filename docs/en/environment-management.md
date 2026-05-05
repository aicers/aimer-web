# Environment Management

The Environments page lets System Admins register, view, edit,
and delete AICE environments, manage customer-environment
mappings, and administer trust registry keys. Navigate to
**Environments** in the admin sidebar to open it.

Only System Admins with the `aice-environments:read` permission
can view this page. The `aice-environments:write` permission is
required to create, edit, or delete environments and manage
customer mappings. Trust registry operations require
`trust-registry:read` and `trust-registry:write`.

![Environments page](../assets/admin-environments-table.png)

## Environment table

The table lists all AICE environments in the system. Each row
shows:

- **AICE ID** — the unique identifier for the environment.
- **Name** — the environment's display name, with an optional
    description shown below.
- **Status** — one of Active, Suspended, or Disabled.
- **Customers** — the number of customers linked to this
    environment. Click the count to manage mappings.
- **Keys** — the number of trust registry keys registered.
    Click the count to manage keys.
- **Actions** — edit and delete buttons.

## Creating an environment

1. Click the **Create Environment** button in the top-right
    corner.
2. Fill in the required fields:
    - **AICE ID** — a unique alphanumeric identifier (hyphens
        and underscores allowed).
    - **Name** — a display name for the environment.
    - **Description** — an optional description.
    - **Status** — the initial status (defaults to Active).
3. Optionally check **Trust Registry Key** to register a key
    alongside the environment:
    - **Issuer** — the token issuer identifier.
    - **Key ID (kid)** — the key identifier.
    - **Public Key (JWK)** — paste the JWK JSON. The server then
        recomputes the RFC 7638 SHA-256 JWK Thumbprint and shows
        it in two formats (see
        [Verifying the JWK Thumbprint](#verifying-the-jwk-thumbprint)
        below).
    - **Key Description** — an optional description.
    - **Expires At** — an optional hard-expiry timestamp; see
        [Key expiration policy](#key-expiration-policy-expires_at)
        for the accepted formats and behavior.
4. Compare the displayed thumbprint against the value shown by
    aice-web-next out-of-band, then toggle the **I confirmed the
    thumbprint matches** checkbox.
5. Click **Create Environment** to submit. The button is disabled
    until the thumbprint confirmation is checked.

![Create environment dialog](../assets/admin-environments-create-dialog.png)

## Editing an environment

1. Click the **Edit** button in the Actions column.
2. Modify the name, description, or status as needed.
3. Click **Save** to apply changes.

## Deleting an environment

1. Click the **Delete** button in the Actions column.
2. A confirmation dialog appears warning that all customer
    mappings and trust registry keys will be permanently removed.
3. Click **Delete** to confirm.

![Delete confirmation dialog](../assets/admin-environments-delete-dialog.png)

Deletion removes the environment record, all associated customer
mappings, and all trust registry keys. This action cannot be
undone.

## Managing customer mappings

Click the customer count in the **Customers** column to open
the customer mapping panel.

### Linking a customer

1. Click the **Link Customer** button.
2. Select a customer from the dropdown. Only customers not
    already linked to this environment are shown.
3. Click **Link Customer** to confirm.

### Unlinking a customer

1. Click the **Delete** button next to the customer.
2. Confirm the removal in the dialog.

## Managing trust registry keys

Click the key count in the **Keys** column to open the trust
registry panel.

### Registering a key

1. Click the **Register Key** button.
2. Fill in the required fields:
    - **Issuer** — the token issuer identifier.
    - **Key ID (kid)** — the key identifier.
    - **Public Key (JWK)** — paste the JWK JSON. The server then
        recomputes the RFC 7638 SHA-256 JWK Thumbprint and shows
        it in two formats (see
        [Verifying the JWK Thumbprint](#verifying-the-jwk-thumbprint)
        below).
    - **Key Description** — an optional description.
    - **Expires At** — an optional hard-expiry timestamp; see
        [Key expiration policy](#key-expiration-policy-expires_at)
        below for the accepted formats and behavior.
3. Compare the displayed thumbprint against the value shown by
    aice-web-next out-of-band, then toggle the **I confirmed the
    thumbprint matches** checkbox.
4. Click **Register Key** to submit. The button is disabled until
    the thumbprint confirmation is checked.

### Verifying the JWK Thumbprint

When a JWK is pasted into the create-environment or register-key
form, the server independently recomputes the RFC 7638 SHA-256
thumbprint of the public key and renders it in two formats:

- **base64url (canonical)** — 43 characters, no padding. This is
    the value to compare for verification.
- **hex (4-byte blocks)** — 64 hex characters grouped in eight
    blocks of 8 characters separated by `:`. Provided as a visual
    aid for verbal or mental comparison.

Both formats encode the same 32-byte SHA-256 digest; only the
rendering differs. Both are displayed in full (no truncation) and
each has a **Copy** button.

The aice-web-next System Administrator transmits the thumbprint
out-of-band — over a separate, trusted channel from the JWK
itself — so that an attacker who could swap the public key during
the paste would not also control the comparison value. Compare
both sides character-for-character before toggling the
confirmation checkbox.

If the JWK is malformed or uses an unsupported `kty`, an error
is shown in place of the thumbprint, the confirmation checkbox
does not appear, and the submit button stays disabled.

Editing the JWK textarea after confirming clears the
confirmation, hides the previously displayed thumbprint, and
re-disables the submit button. The operator must wait for the
new thumbprint to render and re-confirm before the form can be
submitted.

The server-computed thumbprint is also written to the
`trust_registry.key_registered` audit details so the registered
value can be verified after the fact.

<!-- TODO: screenshot - aimer-bridge batch -->

### Key expiration policy (`expires_at`)

Each trust registry key has an optional `expires_at` field with
two possible policies:

- **Soft expiry (default).** Leave the field blank when
    registering. The key remains trusted until an operator
    manually disables or removes it; rotation is policy-driven,
    not enforced by the platform.
- **Hard expiry.** Provide a timezone-explicit ISO 8601 datetime
    such as `2026-05-05T12:00:00Z` or `2026-05-05T21:00:00+09:00`.
    After this moment all bridge requests using this key are
    rejected, regardless of whether the operator has touched the
    `enabled` flag. Rejection is re-evaluated on every verify, so
    the boundary takes effect immediately and is not deferred by
    any caching layer.

The key registration UI is a plain text field. Operators must
enter a timezone-explicit ISO 8601 datetime (with `Z` or
`±HH:MM`) — values without a timezone (e.g.
`2026-05-05T12:00:00`) or date-only values are rejected with a
validation error in the browser before submission and again on
the server.

Past timestamps are accepted intentionally — setting
`expires_at` to a date in the past is a fast way to "burn" a
compromised key without waiting for a separate disable step.

The trust registry keys table shows the expiration distance for
each key:

- **No expiry (soft)** — the field was left blank.
- A specific date — when expiration is more than 30 days away
    (neutral color).
- **Yellow** — within 30 days of expiry.
- **Red** — within 7 days of expiry.
- **Gray "expired"** — past `expires_at`. The key is still
    listed but bridge calls signed with it are denied.

<!-- TODO: screenshot - aimer-bridge batch -->

### Enabling or disabling a key

Click **Disable** or **Enable** in the Actions column to toggle
a key's status. Disabled keys are not used for token
verification.

### Removing a key

1. Click the **Remove** button in the Actions column.
2. Confirm the removal in the dialog.

Removing a key is permanent and cannot be undone.

## Audit trail

Environment management actions are recorded in the audit log:

- **environment.created** — when an environment is registered.
- **environment.updated** — when environment details are
    changed.
- **environment.deleted** — when an environment is deleted.
- **environment.customer_linked** — when a customer is linked.
- **environment.customer_unlinked** — when a customer is
    unlinked.
- **trust_registry.key_registered** — when a key is registered.
- **trust_registry.key_disabled** — when a key is enabled or
    disabled.
- **trust_registry.key_removed** — when a key is removed.

View these entries on the [Audit Logs](audit-logs.md) page.
