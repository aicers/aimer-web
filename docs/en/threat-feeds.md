# Threat Feeds

The Threat Feeds page lets a System Admin manage the Tier-1 threat-intelligence
feeds (abuse.ch Feodo / URLhaus, Spamhaus DROP, the Botvrij.eu IP / domain /
URL / hash lists, the Phishing.Database domain / URL / IP lists, and the CERT
Polska Warning List) plus the **Palo Alto Unit 42**, **ESET**, **Volexity**,
**PRODAFT**, **Zscaler ThreatLabz**, **Huntress**, and **Meta Threat Research**
vendor IOC repositories that observed indicators are matched locally against. It
also manages the **MISP warninglists** false-positive suppression layer (see
[Negative sources (false-positive suppression)](#negative-sources-false-positive-suppression)).
Navigate to **Threat Feeds** in the admin sidebar to open it.

The flat Tier-1 feeds are single published files; a **vendor IOC repository**
(such as Unit 42, ESET, Volexity, PRODAFT, Zscaler ThreatLabz, or Huntress) is
instead a whole Git repository of per-report files that is imported as one unit.
Vendor repositories are **self-fetch only** — see
[Vendor IOC repositories](#vendor-ioc-repositories).

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
| CERT Polska Warning List (`cert-pl/warninglist`) | domain | CERT Polska (best-effort, no SLA) |
| Infoblox Threat Intelligence (`infoblox/threat-intelligence`) | domain, IP, URL, file hash | CC-BY-4.0 — **attribution to Infoblox and the license** |
| Phishing.Database (`phishing-database/domain`) | domain | MIT |
| Phishing.Database (`phishing-database/ip`) | IP | MIT |
| Phishing.Database (`phishing-database/url`) | URL | MIT |
| Spamhaus DROP (`spamhaus/drop`) | IP (CIDR) | Spamhaus |
| Spamhaus EDROP (`spamhaus/edrop`) | IP (CIDR) | Spamhaus (merged into DROP, 2024) |
| MISP warninglists (`misp/warninglists`) | IP (negative / suppression) | CC0 (public domain, no attribution) |

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

**CERT Polska Warning List** is a PL-centric list of active phishing domains,
published as a plain-text "one domain per line" file. It is a best-effort feed
(no SLA), so a stale or unreachable snapshot drives `unknown` / `stale` coverage,
never a silent clean. It is currently supplied via the committed fixture /
manual upload only; **self-fetch is not yet wired** because the data grant in the
archived CERT Polska spec has not been re-confirmed for the current v2 endpoints
(the live fetch is gated on that re-confirmation). It therefore has no cadence
row in the self-fetch table below.

### Negative sources (false-positive suppression)

Most sources are **positive** — a match means the indicator is known-bad. A
**negative** source is the opposite: it lists known-**good** / known-noisy
infrastructure (public DNS resolvers, CDN / cloud IP ranges, bogons), and a
match means the indicator is a likely **false positive**.

**MISP warninglists** (`misp/warninglists`, the `MISP/misp-warninglists`
project, **CC0** public domain) is the first such source. It is **not** a
known-bad feed: a warninglisted indicator never produces a known-IOC hit.
Instead it down-weights that indicator's positive matches before they reach the
analysis floor and evidence surface:

- a deterministic match is **kept as evidence** (still audited and
    explainable) but can no longer drive the binary known-IOC floor;
- a soft-reputation match is **dropped** as a likely false positive;
- the matched warninglist's name is recorded on the suppression evidence, so an
    analyst can see *which* warninglist (for example "List of known IPv4 public
    DNS resolvers") suppressed the indicator.

v1 imports **IP-oriented** lists only — public DNS resolvers (exact IP) and CDN
/ cloud / bogon ranges (CIDR). Domain / URL warninglists (top-sites lists) are
out of scope for now. CC0 carries no attribution obligation, but the source
label records **"MISP warninglists (CC0)"** for provenance. Like Spamhaus EDROP,
this source is supplied via the committed fixture / manual upload today and has
no self-fetch endpoint.

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

Vendor IOC repositories (Unit 42, ESET, Volexity, PRODAFT, Zscaler ThreatLabz,
Huntress, Meta Threat Research) are **not** listed here. A repository is a whole
tree of files imported as one unit, so a single uploaded file could only ever
write a partial, context-stripped snapshot — manual upload of a vendor repository
is therefore rejected, and the source is hidden from this table.
Vendor repositories are refreshed in `self-fetch` mode only (see
[Vendor IOC repositories](#vendor-ioc-repositories)).

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

<!-- Screenshot placeholder: the capture above predates the prodaft/malware-ioc,
     zscaler/threatlabz, and meta/threat-research rows; refreshing the self-fetch
     status table to include PRODAFT is tracked in #646, the Zscaler ThreatLabz
     row in #647, and the Meta row in #649 (foldable into one recapture). -->

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

### Vendor IOC repositories

A **vendor IOC repository** is a whole GitHub repository of per-report files —
indicators bundled with article-level report context (actor / cluster / malware
family / report link) — rather than a single published feed file. aimer-web
imports one through a dedicated path: it enumerates the repository tree, fetches
**only** the allowlisted text files (never binaries, scripts, or rule files),
extracts indicators from each, captures the report context, and replaces the
source's snapshot with every file's rows in one transaction.

| Source | Repository | License | Auth-Key | Cadence floor |
| --- | --- | --- | --- | --- |
| `eset/malware-ioc` | `eset/malware-ioc` | BSD-2-Clause — **retain ESET attribution** | none (keyless) | 1 h |
| `volexity/threat-intel` | `volexity/threat-intel` | BSD-2-Clause (attribution retained) | none (keyless) | 1 h |
| `prodaft/malware-ioc` | `prodaft/malware-ioc` | MIT — **retain the PRODAFT copyright notice** | none (keyless) | 1 h |
| `zscaler/threatlabz` | `threatlabz/iocs` | MIT — **attribution to Zscaler ThreatLabz** | none (keyless) | 1 h |
| `huntress/threat-intel` | `huntresslabs/threat-intel` | MIT — **retain Huntress attribution** | none (keyless) | 1 h |
| `meta/threat-research` | `facebook/threat-research` | MIT (Meta Platforms, Inc.) | none (keyless) | 1 h |

Notes specific to vendor repositories:

- **Self-fetch only.** A repository cannot be supplied by manual upload (a
    single file would write a partial, context-stripped snapshot), so vendor
    sources appear only in `self-fetch` mode and are hidden from the
    manual-upload table.
- **Allowlisted files only.** For Unit 42, only the defanged `.txt` indicator
    lists are parsed (with refanging — `hxxp`/`hXXp` → `http`, `[.]`/`(.)` → `.`).
    The repository's PDF report, Python scripts, multi-megabyte CSVs, and
    Markdown appendices are deliberately **not** fetched or parsed — their
    "indicators" are host artifacts (file paths, registry keys, DLL names), not
    network IOCs. For ESET, only the clean per-family `samples.sha256` hash lists
    are parsed (one SHA256 per line, no refang — the hashes are not defanged).
    Its AsciiDoc narrative (`.adoc`, including each folder's `README.adoc`), YARA
    rules (`.yar`), MISP exports (`.json`), Sigma rules (`.yml`), and other files
    are deliberately **not** fetched or parsed — the network IOCs in the prose
    are a deferred follow-up. For Volexity, only the per-report IOC CSV
    (`iocs.csv` or `indicators/indicators.csv`, at any depth under the year/post
    folders) is parsed; its `attachments/` (which can carry live web-shell
    source), `scripts/` tooling, and `.yar` rule files are deliberately **not**
    fetched. For PRODAFT, only the per-investigation `README.md` reports are
    parsed — indicators are pulled from their Markdown tables (file hashes) and
    fenced code blocks (IPs / domains / URLs); its PDF reports, scripts,
    multi-megabyte CSVs, images, and other Markdown appendices are deliberately
    **not** fetched or parsed. For Zscaler ThreatLabz, only the per-campaign
    `.txt` lists are parsed (refanged the same way). Its Cobalt Strike `.json`
    configs, source templates (`.php`/`.hta`), and YARA rules (`.yara`/`.yar`)
    are **not** fetched, and — critically — neither is the victim check-in
    **`.csv` telemetry** (`Username,Location,Timestamp,IP address,Email`), which
    is PII, not indicators. One known-bad `.txt` (`qakbot/payload_urls.txt`, a
    concatenated-domain data defect) is also excluded so its run-together domain
    is never imported.
- **Live malware is never fetched.** The allowlist enforces this by file path,
    not by inspecting bytes: any blob whose path matches no rule is never
    downloaded. This matters most for PRODAFT, whose repository ships LIVE
    executable `.exe` decryptors — they fall outside the `README.md` allowlist
    and are never fetched or parsed.
- **Value-column parsing (Volexity).** Volexity's CSV is read by **column only**:
    aimer-web extracts the first column (`value`) and classifies each cell by its
    shape — DOMAIN / IP / URL / HASH — refanging `hxxp://` rows and splitting a
    `file` cell that packs several hashes into one row per hash. The remaining
    columns (`description` / `notes`) are never scanned, so a benign domain or URL
    mentioned in a description is **not** ingested as an indicator.
- **Huntress is a deliberately low-yield source.** About 90% of the Huntress
    repository is Sigma / YARA detection rules (`.yml` / `.yar` / `.yara`) —
    detection logic, not atomic indicators — so only its per-incident
    `type,data,info` CSVs are parsed. Within a CSV, only rows whose `type`
    column is an atomic-IOC type (`sha256` / `sha1` / `md5` / `ip` / `ip:port` /
    `domain` / `url`) are kept; the metadata, signature-name, certificate-serial,
    and host-artifact rows are skipped so their IOC-shaped cell values are not
    mistaken for indicators. CIDR-shaped `ip` rows (e.g. `43.173.64.0/18`) are
    also dropped: this source records only atomic host indicators, so a network
    range is not imported as if it were the single host at its base address.
    Indicator volume is expected to grow as Huntress adds CSVs.
- **Soft CIB-context source (Meta).** Meta Threat Research is overwhelmingly
    **coordinated-inauthentic-behavior / influence-ops** material — account and
    page counts and free-text narrative, not atomic network IOCs. aimer-web
    allowlists only the CSVs under `indicators/csv/` and parses them with the
    free-text scanner, so the kill-chain files' count and narrative cells (for
    example `154 Accounts`, `23 Pages`) match no indicator shape and are dropped,
    leaving only the few real domains / URLs and the legacy malware files' atomic
    IOCs. Every row Meta contributes is imported as a **soft-reputation** signal
    and can never become a deterministic / floor-eligible match — CIB attribution
    is suggestive context, not a confirmed indicator hit. The `.tsv` mirror, the
    legacy `.json` / STIX exports, Markdown notes, and `signatures/yara/` rule
    files are excluded and never fetched.
- **Keyless fetch (v1).** Fetching is keyless — no Auth-Key is configured or
    accepted for Unit 42, ESET, Volexity, PRODAFT, Zscaler ThreatLabz,
    Huntress, or Meta — and relies on GitHub's unauthenticated rate limit, which
    is ample for the 1 h cadence floor. An operator GitHub token to lift that
    rate limit is **not** wired up in this release; token support is deferred to
    a follow-up.
- **Report context.** Each imported indicator carries the per-file GitHub blob
    URL and the report context the repository encodes: for Unit 42 the campaign
    id where the filename carries one (for example `CL-STA-0910`); for ESET the
    malware family from the enclosing folder name (for example `gamaredon`, or
    the mixed-case `GhostRedirector`); for PRODAFT the investigation folder
    codename (for example `RagnarLoader`) stored verbatim as the actor — the
    codenames do not map to public actor names; for Zscaler ThreatLabz the
    per-campaign folder name (for example `qakbot`) as the campaign id; and for
    Huntress the incident name from the CSV filename. This is surfaced as the
    indicator's provenance. **Meta supplies neither a blob URL nor a campaign
    id**: its paths contain spaces / `#` / `&` / non-ASCII that the blob-URL
    template cannot encode, and its period / country / network labels are not
    part of the supported context model, so Meta rows are imported without
    either.
- **Attribution.** ESET is published under **BSD-2-Clause** and PRODAFT,
    Zscaler ThreatLabz, Huntress, and Meta under **MIT**, both of which require
    the copyright notice to be retained, so their source labels carry the
    **"ESET (BSD-2-Clause)"**, **"PRODAFT (MIT)"**, **"Zscaler ThreatLabz
    (MIT)"**, **"Huntress (MIT)"**, and **"Meta Threat Research (MIT)"**
    attributions by construction (surfaced wherever a matched indicator cites
    the source).

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
