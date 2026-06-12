# Threat Feeds (Manual Upload)

The Threat Feeds page lets a System Admin upload Tier-1 threat-intelligence
feed files so that observed indicators can be matched locally against
known-bad IOCs. Navigate to **Threat Feeds** in the admin sidebar to open it.

This is the **manual-upload** supply mode: the operator obtains each feed file
out-of-band and provides it to aimer-web. No outbound internet fetch is
involved, which makes it the supply mode for development and for air-gapped /
closed-network deployments.

The page (and its API) is only available when the deployment is configured
with `TI_FEED_MODE=manual-upload`. In any other mode the nav entry is hidden
and the routes return 404, so operator-provided snapshots cannot be silently
clobbered by fixture re-seeding or a later refresh worker.

Only System Admins with the `ti-feed:write` permission can upload feeds. The
`ti-feed:read` permission is required to view the status table.

![Threat Feeds status table](../assets/admin-ti-feeds-table.png)

## Feed status table

The table lists every known Tier-1 source. Each row shows:

- **Source** — the human-readable source name and its policy id
    (for example, `abuse.ch/feodo`).
- **Entries** — the number of indicator rows currently imported for the
    source.
- **Last Updated** — the upload time recorded for the current snapshot, or
    "Never" when no snapshot is present.
- **Freshness** — a badge derived from the source's freshness bound
    (`maxAge`): **Fresh**, **Stale**, or **Not uploaded**. A snapshot whose
    last-updated time is older than the bound is shown as Stale.
- **Actions** — an Upload button.

A source with no snapshot rows reports **Not uploaded** with zero entries.
This is also how a source that was cleared by an empty upload appears: status
is derived purely from the imported rows, so a cleared source looks identical
to one that was never uploaded.

## Uploading a feed

1. Click the **Upload** button in the row for the source you want to update.
2. A dialog appears with a file picker.
3. Choose the feed file for that source.
4. Click **Upload** to import it.

![Upload feed file dialog](../assets/admin-ti-feeds-upload-dialog.png)

When a file is uploaded, the server:

- parses it using the source's configured parser,
- normalizes the entries into indicator rows, and
- **replaces** the source's snapshot in a single transaction (delete then
    insert), stamping each row with the upload time.

The response reports how many rows were imported.

### Upload rules

- The file format must match the selected source (for example, the
    abuse.ch Feodo Tracker IP blocklist for `abuse.ch/feodo`). A file whose
    lines cannot be parsed into any entries is rejected with an error.
- A genuinely empty or comment-only file is accepted and **clears** the
    source (the snapshot is emptied), reporting zero imported rows.
- Re-uploading a source always replaces its previous snapshot rather than
    appending to it. Concurrent uploads of the same source are serialized so
    the replace-not-append guarantee always holds.
- There is a maximum upload size; oversized files are rejected.

## Backup

Because a manually-uploaded snapshot is not re-derivable from committed
fixtures, the feed database is a backup/restore target. Include it in backups
with the `feed` target (or the `all` target). See
[Backup & Restore](backup-restore.md).
