# Threat Feeds

The Threat Feeds page lets a System Admin manage the Tier-1 threat-intelligence
feeds (abuse.ch Feodo / URLhaus, Spamhaus DROP, the Botvrij.eu IP / domain /
URL / hash lists, and the Phishing.Database domain / URL / IP lists) that
observed indicators are matched locally against. Navigate to **Threat Feeds**
in the admin sidebar to open it.

Only System Admins with the `ti-feed:write` permission can change feeds (upload
or fetch); the `ti-feed:read` permission is required to view the status table.

How feeds reach aimer-web is controlled by the **supply mode**
(`TI_FEED_MODE`). The Threat Feeds page is available — and the nav entry is
shown — in two modes:

- **`manual-upload`** — the operator obtains each feed file out-of-band and
    uploads it. No outbound internet fetch; the mode for development and for
    air-gapped / closed-network deployments.
- **`self-fetch`** — the instance fetches each feed directly over HTTP and
    imports it on demand. The production refresh path for on-prem /
    independent / sovereignty deployments, which fetch each feed's upstream
    directly (the license-sanctioned path, no redistribution).

In any other mode the nav entry is hidden and the routes return 404, so
operator-managed snapshots cannot be silently clobbered. The page renders the
controls for the active mode only: the upload dialog in `manual-upload`, and
the per-source **Fetch Now** action plus the URLhaus **Auth-Key** control in
`self-fetch`.

---

## Sources

The known Tier-1 sources, the indicator types each contributes, and their
licensing:

| Source (policy id) | Indicator types | License / attribution |
| --- | --- | --- |
| abuse.ch Feodo Tracker (`abuse.ch/feodo`) | IP | abuse.ch |
| abuse.ch URLhaus (`abuse.ch/urlhaus`) | URL, domain | abuse.ch |
| abuse.ch URLhaus payloads (`abuse.ch/urlhaus-payloads`) | file hash | abuse.ch |
| Botvrij.eu (`botvrij/ip`) | IP | Botvrij.eu (no resale) |
| Botvrij.eu (`botvrij/domain`) | domain | Botvrij.eu (no resale) |
| Botvrij.eu (`botvrij/url`) | URL | Botvrij.eu (no resale) |
| Botvrij.eu (`botvrij/hash`) | file hash | Botvrij.eu (no resale) |
| Infoblox Threat Intelligence (`infoblox/threat-intelligence`) | domain, IP, URL, file hash | CC-BY-4.0 — **attribution to Infoblox and the license** |
| Phishing.Database (`phishing-database/domain`) | domain | MIT |
| Phishing.Database (`phishing-database/ip`) | IP | MIT |
| Phishing.Database (`phishing-database/url`) | URL | MIT |
| Spamhaus DROP (`spamhaus/drop`) | IP (CIDR) | Spamhaus |
| Spamhaus EDROP (`spamhaus/edrop`) | IP (CIDR) | Spamhaus (merged into DROP, 2024) |

**Infoblox Threat Intelligence** is a domain-heavy membership + classification
feed published as one mixed CSV schema (`type,indicator,classification,…`),
where the indicator type is carried per row (`domain` / `ip` / `ipv4` / `url` /
`sha256` / …) and the values are defanged. aimer-web imports only the rows whose
classification is a recognized threat label (for example `malicious`,
`phishing`, `malware`); non-threat labels such as `legitimate` and `parked` are
not imported, and indicator types with no local equivalent (`email`,
`telfhash`) are skipped. It is released under **CC-BY-4.0**, which requires
attribution wherever a matched indicator surfaces — so its source label carries
the **"Infoblox Threat Intelligence (CC-BY-4.0)"** attribution by construction.
This source is supplied via the committed fixture / manual upload today; it has
no self-fetch endpoint (its content is many per-campaign files with no stable
"latest" URL).

---

## Manual-upload mode

This is the **manual-upload** supply mode (`TI_FEED_MODE=manual-upload`): the
operator provides each feed file directly.

![Threat Feeds status table](../assets/admin-ti-feeds-table.png)

### Feed status table

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

### Uploading a feed

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

#### Upload rules

- The file format must match the selected source (for example, the
    abuse.ch Feodo Tracker IP blocklist for `abuse.ch/feodo`). A file whose
    lines cannot be parsed into any entries is rejected with an error.
- A genuinely empty or comment-only file is accepted and **clears** the
    source (the snapshot is emptied), reporting zero imported rows.
- Re-uploading a source always replaces its previous snapshot rather than
    appending to it. Concurrent uploads of the same source are serialized so
    the replace-not-append guarantee always holds.
- There is a maximum upload size; oversized files are rejected.

---

## Self-fetch mode

This is the **self-fetch** supply mode (`TI_FEED_MODE=self-fetch`): the
instance fetches each feed directly over HTTP and imports it. Refreshes are
**operator-triggered** (a **Fetch Now** action per source) and, optionally, run
on a **background schedule** that is **disabled by default** (see
[Scheduled refresh](#scheduled-refresh)).

![Threat Feeds page in self-fetch mode](../assets/admin-ti-feeds-selffetch-table.png)

### Per-source fetch configuration

Each source has a built-in fetch URL and a **hard cadence floor** — the minimum
time between fetches, which nothing overrides. The floor avoids over-fetching
each upstream provider: for the abuse.ch / Spamhaus exports it guards against an
IP ban (5 min), and for the Botvrij.eu and GitHub-hosted Phishing.Database lists
it is a 1 h courtesy floor:

| Source | Endpoint (variant) | Auth-Key | Cadence floor |
| --- | --- | --- | --- |
| `abuse.ch/feodo` | Feodo recommended plain-text IP blocklist | — | 5 min |
| `abuse.ch/urlhaus` | URLhaus URL CSV export | required | 5 min |
| `abuse.ch/urlhaus-payloads` | URLhaus payloads CSV export | required | 5 min |
| `botvrij/ip` | Botvrij `ioclist.ip-dst.raw` + `ioclist.ip-src.raw` | — | 1 h |
| `botvrij/domain` | Botvrij `ioclist.domain.raw` + `ioclist.hostname.raw` | — | 1 h |
| `botvrij/url` | Botvrij `ioclist.url.raw` | — | 1 h |
| `botvrij/hash` | Botvrij `ioclist.md5.raw` + `ioclist.sha1.raw` + `ioclist.sha256.raw` | — | 1 h |
| `phishing-database/domain` | Phishing.Database active phishing-domains list | — | 1 h |
| `phishing-database/ip` | Phishing.Database active phishing-IPs list | — | 1 h |
| `phishing-database/url` | Phishing.Database active phishing-links list | — | 1 h |
| `spamhaus/drop` | Spamhaus DROP `drop_v4.json` + `drop_v6.json` (NDJSON) | — | 1 h |

Spamhaus **EDROP was merged into DROP** (2024), so `spamhaus/edrop` is no
longer fetched independently — it shows as **Merged into DROP** with no Fetch
Now button. DROP is fetched as NDJSON (one JSON object per line) over the
`drop_v4.json` + `drop_v6.json` endpoints.

Botvrij.eu publishes general IOC coverage (IP / domain / URL / hash) as plain
per-type lists. aimer-web fetches the bare **`.raw`** variant of each list (one
indicator per line, no header or inline annotation) — not the default
`ioclist.<type>` files, whose trailing per-line comments would not parse. The IP,
domain, and hash sources each concatenate several `.raw` files into one source
(for hashes, the MD5 / SHA-1 / SHA-256 lists are distinguished by digest length).
Botvrij refreshes irregularly, so a conservative 1 h cadence floor is used.

### URLhaus Auth-Key

URLhaus requires an Auth-Key (free, from abuse.ch). aimer-web sends it as part
of the download URL path per the current URLhaus export API.

- Use the **Set Auth-Key** / **Replace Auth-Key** control at the top of the
    page to submit the key.
- The key is **encrypted at rest** (OpenBao Transit envelope encryption) and
    is **write-only**: it is never displayed again. The panel only shows
    whether an Auth-Key is currently configured.
- Until an Auth-Key is set, the URLhaus sources cannot be fetched (a fetch
    reports an error).

![Set URLhaus Auth-Key dialog](../assets/admin-ti-feeds-selffetch-authkey-dialog.png)

### Fetching a feed

Click **Fetch Now** in the row for the source you want to refresh. The server
fetches the feed (a conditional request using the stored `ETag` /
`Last-Modified`, with a timeout), imports it, and reports the outcome:

- **Imported** — the feed was fetched and its snapshot replaced; the response
    reports how many rows were imported (which may be **0** for a legitimately
    empty feed, e.g. Feodo on a quiet day).
- **Not modified** — the source returned `304 Not Modified`; the snapshot is
    left untouched but the source is revalidated as current (its freshness
    clock advances).
- **Too soon** — the cadence floor has not yet elapsed since the last fetch;
    nothing is fetched.
- **Error** — the fetch failed (network / timeout / HTTP error / missing
    Auth-Key), **or** the server returned a `200` whose body carries data but
    parses to no recognizable entries (e.g. an upstream HTML error / block page,
    or a feed-format change). In either case the existing snapshot is left
    untouched and its freshness is **not** advanced, so it decays toward Stale
    naturally — a bad response can never wipe a good snapshot. (A genuinely
    empty or comment-only feed is *not* an error; it imports 0 rows as above.)

Each source is single-flighted: a Fetch Now while another fetch of the same
source is already in progress is skipped rather than run twice.

### Scheduled refresh

By default the instance only fetches when an operator clicks **Fetch Now**. The
**Scheduled refresh** panel at the top of the page turns on a background worker
that refreshes the feeds automatically on a timer.

![Scheduled refresh panel, disabled by default](../assets/admin-ti-feeds-selffetch-schedule.png)

- **Disabled by default — on purpose.** Fleet / SaaS deployments refresh
    indicators through the central mirror, not by each instance fetching
    abuse.ch / Spamhaus on its own timer. The engine's single-flight lock is
    **per feed database**, so it does not coordinate across per-customer
    databases — many instances on independent schedules would multiply the
    outbound request rate and risk an upstream IP ban. The scheduler therefore
    ships **off** and is opt-in for **on-prem / independent / sovereignty**
    operators who run a single instance and want hands-off refresh.
- **Enable.** Tick **Enable background refresh** and click **Save schedule**.
    The worker then fetches each fetchable source whenever it becomes due.
- **Interval.** The optional **Refresh interval (minutes)** is the desired
    cadence between refreshes. Leave it **blank** to refresh each source as
    often as its license allows (its cadence floor); because an unchanged feed
    answers a conditional request with a cheap `304`, frequent polling is
    inexpensive. A value **shorter** than a source's cadence floor is **clamped
    up** to that floor — the per-source floor (5 min / 1 h, see the table above)
    is the hard minimum and nothing overrides it.

The scheduler only **drives** the existing fetch engine on a timer; every fetch
still goes through the same single-flight lock, cadence floor, conditional GET,
and replace-only import as a **Fetch Now**. The scheduler is inactive outside
`self-fetch` mode and while it is disabled.

### Status table

In self-fetch mode each row shows the **Fetch URL**, the **Last Fetched** time,
the **Next Fetch** time (when the scheduler would next refresh the source at the
effective cadence; **Off** while the schedule is disabled, and **Due now** for a
source that has never been fetched — the next tick will refresh it), the last
fetch
**Status** (`ok` / `not-modified` / `error`, with the error message on hover),
and a **Freshness** badge. Presence and freshness come from the last successful
fetch time — so a source that fetched successfully but imported 0 rows still
reads as present and fresh, and a source revalidated by a `304` stays fresh. The
Last Fetched / Next Fetch values are derived from each source's own fetch
state, not from a separate scheduler record.

---

## Backup

Because feed snapshots (and the stored Auth-Key) are not re-derivable from
committed fixtures, the feed database is a backup/restore target. Include it in
backups with the `feed` target (or the `all` target). See
[Backup & Restore](backup-restore.md).
