# RFC 0004: Summary subjects — customer groups and report navigation

- Status: **Draft** (pre-review; to be refined before scoping implementation issues)
- Authors: @sehkone
- Tracks (consumers): to be created from this doc (see "Candidate implementation issues")
- Depends on: RFC 0001 (analysis storage, redaction), RFC 0002 (periodic LLM analysis, report buckets)
- Related: [#386](https://github.com/aicers/aimer-web/issues/386) (periodic-report IA umbrella), customer retention policy (`customer_retention_policy`)

## Summary

Two navigation problems surfaced while reviewing how reports, threat stories, and suspicious events are browsed today, and they share one root cause.

1. **No menu path to a single customer's view.** The sidebar menu (개요 / 보고서 / 위협 스토리 / 의심 이벤트) only navigates to *cross-customer* surfaces. The per-customer hub at `/customers/[customerId]` is reachable **only** by drilling into a detail page and then clicking the customer name in the breadcrumb — a reverse-direction path to what is conceptually a *higher* level than the detail it came from.
2. **No way to navigate accumulating reports.** Periodic reports keep piling up over time, but the report surfaces are **hard-capped, not paginated** (LIVE 1 / DAILY 14 / WEEKLY 8 / MONTHLY 12 per period; cross-customer top-25). There is no calendar, date picker, pagination, "load more", or within-period prev/next. Reports older than the cap exist but are **unreachable from the UI**.

The root cause is that the product conflates **two independent axes** that happen to both touch "customers":

- An **ephemeral scope filter** (the sidebar checkboxes) — a transient, URL-driven subset used to filter cross-customer browse lists. Produces nothing.
- A **persistent summary subject** — a pre-configured unit for which summary/report artifacts are *continuously produced* over time.

This RFC separates the two axes cleanly, introduces the **summary subject** as a first-class entity (a single customer **or** a pre-defined **customer group**), restructures navigation around it, and defines **temporal navigation** for the reports that accumulate under each subject.

## Motivation

- **The hub is orphaned.** `/customers/[customerId]` sits above the per-customer detail pages but has no first-class entry point. See `src/components/sidebar.tsx` (all menu items point to WS2 cross-customer routes) and `src/components/breadcrumbs.tsx` (the `[customerId]` segment is the *only* link to the hub; the `customers` segment is plain text with no index page).
- **Aggregate summaries are a real need, and they are not on-the-fly.** Users want summary/dashboard information for *multiple customers treated as one unit*, not just one customer. But because reports/summaries are produced by a background pipeline over time (RFC 0002), the unit they are produced for must be **defined ahead of time** — it cannot be derived from a transient checkbox selection at page-load.
- **The scope filter cannot carry this.** `NormalizedScope` (`src/lib/navigation/scope.ts`) is an ephemeral list of customer IDs in the `?scope=` query param. It has no persistence and drives no artifact generation. Trying to overload it as "the thing reports are generated for" is a category error.
- **Accumulation has no navigation.** Today `discoverReportBuckets()` (`src/lib/analysis/report-index-page-loader.ts`) caps each period and the cross-customer page caps at 25; nothing can reach older buckets. As reports accumulate, more and more history becomes invisible. Introducing groups would replicate and amplify this gap.

## Non-goals

- **Retroactive group reports.** A group's report generation begins **at group creation time**; there is no backfill of reports for periods before the group existed. (Explicit constraint — see "Customer groups".)
- **Replacing the ephemeral scope filter.** The sidebar checkbox filter stays as a lightweight way to browse cross-customer lists. The filter is **not** the mechanism for *defining* groups (no "save this selection as a group"). Already-defined groups may, however, appear as **presets** in the filter as a convenience for selecting their members when browsing — a one-way reference to an existing group, not a definition path, and distinct from opening the group's own aggregated report.
- **No bridge-specific group handling.** A bridge session authenticates as a real aimer-web account via OIDC and **opens a full aimer-web tab** — so users expect it to behave exactly like a normal sign-in (decided). It therefore carries the account's own permissions and scope like any session, and group visibility follows the same all-member rule with no bridge-specific handling. The current bridge restrictions (locked scope selector, cross-customer block, read-only) run contrary to that expectation and should be lifted to full sign-in parity — an existing-behavior change tracked separately from this RFC (see Relationships); read-only-ness is a separable axis and, if kept at all, needs its own justification.
- **Changing RFC 0002's report-generation *semantics* for single customers.** Single-customer periodic reports keep their current generation behavior and bucket semantics. This RFC *adds* a group dimension alongside; it does not rework how a customer's reports are produced. (Note: the *storage key* does change — the `(customer_id, …)` key is re-keyed to `(subject_id, …)` under Routing Alt 1. That is a key/identity change, not a semantics change, and is free pre-release.)
- **Unbounded history.** Temporal navigation is bounded by the retention policy; this RFC does not propose retaining reports longer than the retention window.
- **A general org/tenant hierarchy.** A customer group is a flat, named set of customers, not a nested organizational tree.

---

## Conceptual model

### Two independent axes

The central correction. These were conflated; they must be separated.

| | **Scope filter** | **Summary subject** |
| --- | --- | --- |
| Nature | ephemeral, on-the-fly | pre-configured, persistent |
| Defined where | `?scope=` checkboxes (sidebar) | dedicated settings screen |
| Produces artifacts? | **No** — filters browse lists only | **Yes** — reports / stories / events summaries generated continuously |
| Target | arbitrary subset of accessible customers | a single customer **or** a pre-defined group |
| Lifetime | a browsing session | until explicitly deleted |

### The summary subject

A **summary subject** is the unit that periodic analysis is produced for. It is a first-class entity with exactly two kinds:

| Subject kind | Meaning | Status |
| --- | --- | --- |
| `customer` | one customer | exists today (the orphaned hub is its surface) |
| `group` | several customers **treated as one unit** | **new** (this RFC) |

The single-customer hub is therefore the special case of a general "subject hub". Both kinds expose the **same** artifact shape: periodic reports, threat-story summaries, suspicious-event summaries, and (future) dashboards.

### Customer groups

A **customer group** is a new, persisted, first-class entity: a named set of customers whose analysis is generated as if they were one customer.

Decided constraints:

- **Generation starts at definition time, no retroactive fill.** When a group is created, the report/summary pipeline begins producing artifacts for it from that moment forward. Periods that closed before the group existed are simply absent — they are not backfilled. This bounds the cost of group creation and avoids reprocessing historical customer data.
- **A group has its own dedicated database, storing generated analysis (Option B).** Just as each customer has its own database, a group gets a **separate database** of its own — a peer of the per-customer databases. It holds the group's **generated reports/summaries**, not a copy of raw member events: at each generation run the pipeline **pulls** the period window from every member database, combines them in memory, produces one aggregated report over the underlying events, and persists only that result in the group database. So a group is a true first-class, customer-like subject and its report is a real aggregation over members' raw events — not a report-of-reports — but raw events are **not duplicated** into the group DB. (Decided: Option B over Option A; keeps cross-customer raw data out of a shared store, preserving per-customer envelope-encryption isolation.)
- **Definition is restricted: Manager or Analyst on every member.** A user may define a group only if, for **every** member customer, they hold the **Manager or Analyst** role on it — the per-customer privileged roles. (Regular *User* cannot; and the global *System Administrator*, which has **no per-customer data access** at all, is not involved — group definition lives entirely in the per-customer `general` auth context.) So a Manager/Analyst on A, B, C may create A+B, B+C, A+C, or A+B+C; someone privileged on only A, B may create only A+B — and an A-Manager who is a mere User on B cannot create A+B. The role gate exists because group creation triggers continuous report generation, which **costs tokens** — not a power handed to ordinary users.
- **Viewing requires the per-surface read permission on every member.** A group's surfaces are visible only to users holding the relevant permission on **all** of its member customers — `reports:read` for the group's reports, `analyses:read` for its threat-story / suspicious-event summaries (the same per-surface permissions used for single customers, but required on *every* member). The A+B+C group's reports open only to those with `reports:read` on A *and* B *and* C; missing it on even one member denies the whole group, and if a member later becomes inaccessible they lose the group. Viewing is not otherwise role-gated, since the costly part (generation) already happened at creation. This all-member rule is the *only* gate on group visibility — there is no session-type-specific exclusion (see Non-goals on bridge sessions).
- **Membership is immutable.** Once a group is created, its member set cannot be edited (no adding or removing customers). This keeps the non-retroactive model simple — there is never a partially-covered member history to reason about. (Existence/state transitions still happen — see "Group lifecycle" — but the *member set* never changes.)
- **Flat membership.** A group is a flat set of customer IDs. No nesting; a customer may belong to multiple groups.

### Group lifecycle

A group must always have at least one **manager** — an account holding Manager/Analyst on *every* member (the same predicate as creation). A group may **never** persist with only viewers. Transitions:

- **Ownership and manual deletion.** Each group has a single **owner** with manual-delete rights, starting as the creator. When the owner leaves (or loses Manager/Analyst on a member), ownership **transfers automatically to one remaining manager by a deterministic rule** — Manager role preferred over Analyst, then oldest membership, then lowest account UUID (deterministic for auditability/reproducibility, not arbitrary). Only the current owner may manually delete the group (which tears down its database).
- **Auto-deletion (DB torn down)** when either:
  - **no account holds Manager/Analyst on all members** any longer (the last manager is gone — a viewer-only group is not allowed to exist), or
  - **any member customer is deleted** (member deletion cascades to group deletion).
- **Auto-suspension.** When **any member customer becomes non-operational** — `status = 'suspended'`, or `database_status = 'failed'` (its DB is unreadable) — the group is suspended too: **report generation pauses, but existing reports remain viewable (read-only)**. It resumes when every member returns to `status = 'active'` / `database_status = 'active'`. (Classifying `status = 'disabled'` as suspend-like vs delete-like is a small residual.)
- **Generation continuity.** Generation keeps running as long as a qualifying manager exists; the owner merely *leaving* does not stop it — ownership transfers and generation continues. Viewers are irrelevant to existence.

### What does NOT change

- Ownership splits by artifact kind under Option B. A **report/summary** belongs to exactly one subject — a customer's report to that customer, a group's report to that group (group reports live in the group DB). But the **underlying story/event details remain customer-owned**: raw stories and events stay in the member customer DBs; the group DB holds only generated summaries, never raw member events. So on a group surface, a story/event entry is a **group-owned summary artifact** whose **source detail links back to the owning member customer**, not a group-owned raw record. (This is a statement about *data ownership*, not routing — see "Routing" for where the surfaces live; the whole analysis surface is addressed under the subject.)
- The ephemeral scope filter keeps working exactly as today for cross-customer browse lists.

---

## Navigation design

### Target structure

```
Sidebar
├─ Summary subjects            ← NEW. customers + groups as first-class entries
│    └─ <subject> → subject hub (reports / stories / events summaries, + future dashboard)
│         └─ detail (one report / one story / one event)   ← under the same subject route
│
├─ 개요 / 보고서 / 위협 스토리 / 의심 이벤트   ← cross-customer browse lists
│    (filtered by the ephemeral scope checkboxes; no artifact generation)
│
└─ 계정 설정 / 멤버 / 고객 설정
     └─ + Group settings (define / edit / delete groups)   ← NEW
```

### How this resolves the reported gaps

- **The hub gap (problem 1) dissolves:** summary subjects appear first-class in the sidebar, so a customer's (or group's) hub is reached *directly from the menu* rather than via the breadcrumb reverse-path. The breadcrumb customer link remains as a secondary affordance.
- The ephemeral scope filter and the summary subject are now visibly different controls with different jobs, removing the conceptual overload.

### Routing (decided — Alt 1, full switch to `/subjects`)

A customer and a group are both report-producing subjects with their own database, so the **entire** analysis surface (hub, list, **and** detail) is addressed under the subject — not split between `/customers` and `/subjects`.

**Decision: Alt 1 — full switch to `/subjects/[subjectId]/...`.** Introduce a `subjects` supertype (`id`, `kind ∈ {customer, group}`) that `customers` and `customer_groups` extend; reports, retention, and provisioning key uniformly on `subject_id`, one ID namespace. Customer-only admin (member management, customer settings) stays on customer-scoped routes; only the analysis surface moves. The breadcrumb gains a real subject entry (or the subject list lives in the sidebar), closing the orphaned-hub gap.

**Why Alt 1 over Alt 2 (keep `/customers/[id]` + a `subject` facade for groups):** Alt 2's only real advantage is less immediate churn, but it leaves **two URL shapes and two keyings permanently**, with a standing facade and a real risk of customer/group feature drift. Alt 1's apparent downside — blast radius — is much smaller than it looks here:

- **DB re-key is effectively free (pre-release).** The project is pre-deployment with a dev-DB reset policy, so re-keying `periodic_report_*` from `customer_id` to `subject_id` carries **no migration/backfill cost** — change the schema and reset. The remaining Alt 1 cost is code churn + the external contract, not data migration.
- **The external contract is preserved by an alias.** RFC 0002 fixes an aice-web-next deep-link at `/customers/{customer_id}/analysis/story/{story_id}` (and sibling `/analysis/...` links). A `/customers/[id]/...` → `/subjects/[id]/...` redirect/alias keeps those links working, so the switch does **not** break aice-web-next; RFC 0002's contract is amended to name `/subjects` as canonical with the alias as compatibility.
- **Cheaper now than later.** Pre-release is when the least `customer_id`-centric code (sidebar, loaders, worker, retention sweeper) exists; re-keying now beats re-keying after more accumulates.

Net: Alt 1's costs are bounded (code churn now + a contract amendment with an alias), while its benefits (single identity, single route tree, no permanent facade or drift, future subject-level features apply to both kinds automatically) are durable — and it matches the already-decided "a group is a customer-like first-class subject with its own DB."

---

## Temporal navigation (accumulating reports)

Chosen approach: **calendar / date-jump + within-period prev/next, bounded by retention.** This replaces today's "cap and drop" model.

### 1. Calendar / date jump

Periodic reports are inherently date buckets, so a date-addressable control is the natural primary navigation:

- The calendar's granularity matches the period: **DAILY → a month/day grid, WEEKLY → a list of weeks, MONTHLY → a year/month grid.** LIVE is the single rolling "now" bucket and needs no calendar.
- The calendar **visually distinguishes** buckets that have a ready report, buckets with none, and buckets **outside the retention window** (greyed, not navigable).
- Selecting a bucket jumps to its report. The calendar is the opt-in path to history; the default landing for a subject is always the most recent report.
- **The hub keeps a short "recent" preview** (the current capped recent list), with the calendar as the "view all / go back" affordance — the hub does not render a full calendar inline.

### 2. Within-period prev/next (on the detail page)

- Add ◀ previous / next ▶ within the *same* period (e.g. yesterday's DAILY, last week's WEEKLY). This complements today's period tabs (LIVE/DAILY/WEEKLY/MONTHLY in `src/components/analysis/report-period-tabs.tsx`), which switch *period* but not *time*.
- Prev/next **stops at the retention boundary**; reaching it shows an explicit "no older reports retained" state rather than a dead link or a 404.

### 3. Retention is the single boundary

- Invariant: **navigable range ≤ retained range.** The retention policy is the single source of truth for the boundary, for both the calendar's "out of range" styling and prev/next's stop condition.
- For a **customer** subject this is `customer_retention_policy`; for a **group** subject a report bucketed at date `D` is retained until **`D + min(group_policy_days, min_over_members(H_c))`**, where `H_c = max(ingestion_days, coalesce(analysis_days, ∞))` per member (`analysis_days = NULL` ⇒ no expiry ⇒ that member does not bound the group). See the P1 callout for the derivation, bucket-date clock note, and sweeper ordering. A report past that bound is **dropped, not kept as a degraded display** — losing old group history is accepted in exchange for "everything shown is fully de-redactable" and keeping cross-customer sensitive data out of the group DB.
- This replaces the per-period numeric caps as the *navigation* limit. (The caps may survive as a "recent" preview on the hub, but they no longer define what is reachable.)

> **P1 — group retention vs. member redaction-map retention (decided: Option (a)).** Under Option B the group report (with redacted tokens) lives in the group DB, but the **de-redaction map lives in each member DB** and RFC 0001 reaps it once *no referencing row in that member DB* is still in retention (RFC 0001 §Retention, `event_redaction_map`). A group result is **not** such a referencing row, so a group report outliving a member's map becomes un-de-redactable. **Decision: Option (a), made computable from policy.** RFC 0001 keeps an event's map while a referencing ingestion *or* analysis row is retained, so for any event a member's map is guaranteed alive for **`H_c = max(ingestion_days, coalesce(analysis_days, ∞))`** from that member's `customer_retention_policy`. Crucially, **`analysis_days = NULL` means *no expiry*** (RFC 0001 §Retention — permanent analysis retention), so such a member has `H_c = ∞` and therefore does **not** bound the group (it drops out of the `min`); only members with finite retention constrain it. **Assumption behind the `analysis_days` term:** it only applies to a referenced event that actually has a member-side analysis / story-analysis row (the rows `analysis_days` governs). Group report inputs that carry event tokens must therefore reference such member-side analysis rows; **if a future group generator includes raw redacted events without a member-side analysis row, the bound for those refs falls back to `ingestion_days`** (the map is then held only by the ingestion row). Implementations must either guarantee analysis-row-backed inputs or compute `H_c` per ref from whichever member-side rows actually exist. Therefore a **group report bucketed at date `D` is retained until `D + min(group_policy_days, min_over_members(H_c))`** and reaped after — guaranteeing every surviving group report is fully de-redactable, and keeping cross-customer sensitive data out of the group DB (Option B isolation), at the cost of group history depth being limited by the shortest finitely-retaining member. **Clock note:** `D` is the report's **bucket date** — a deliberate choice. RFC 0001's general retention clock runs from *row-entry* time, but a group report's referenced events cluster around its bucket date, so `D + H_c` approximates when those members' maps expire; this intentional difference is noted so the sweeper is built against bucket date, not row-entry time. **Sweeper ordering:** the group-report reaper keys off the same member policies and runs **before or together with** the member-side `event_redaction_map` sweep; if a member later shortens its policy, `H_c` shrinks and the affected group reports are reaped accordingly, never left showing missing tokens. Rejected: (b) group persists its own demap (re-introduces cross-customer sensitive data — undoes Option B); (c) degraded token display past member retention. Under RFC 0001 defaults `H_c` ≈ 36 months, so the bound only bites when a member sets short retention. (Row-level tracking is unnecessary **for v1** because the generator guarantees analysis-row-backed token inputs, making `H_c` policy-time-uniform per customer; if a future generator allows raw-event-only refs, that implementation must compute the bound per referenced input.)

---

## Data model implications

- **`subjects` supertype** (Routing Alt 1, decided) — a shared identity table (`id`, `kind ∈ {customer, group}`, timestamps) that `customers` and `customer_groups` extend, so reports, retention, provisioning, and routing key uniformly on `subject_id`. This is a **reshaping** change (a customer becomes a kind of subject) that also re-keys `periodic_report_*`; the DB re-key is free pre-release (reset), and the RFC 0002 deep-link contract is preserved via a `/customers → /subjects` alias — see Routing. Everything below is additive on top of it.
- **`customer_groups`** — extends `subjects`; `name`, `description`, `created_by`, `created_at`. The creation timestamp anchors the "no retroactive generation" rule.
- **`customer_group_members`** — join `(group_id, customer_id)`. **Immutable after creation** — no add/remove; the row set is fixed at group creation. Membership is constrained to the creator's accessible customers.
- **Group database (Option B — results only)** — a group has its **own dedicated database**, a peer of the per-customer databases (decided), holding **generated reports/summaries only — not raw member events**. Provisioning mirrors the per-customer database model (`customers.database_status` → a subject-level status). **Deleting a group tears its database down** (the only lifecycle mutation).
- **Report storage key** — re-key `periodic_report_state` / `periodic_report_job` from `customer_id` to **`subject_id`** so one set of tables serves both customers and groups. Single-customer *generation semantics* are unchanged (see Non-goals); only the storage key moves — a key/identity change, free pre-release.
- **Group timezone** — a stored `tz` on the group row, resolved at creation: auto-adopt the members' shared tz when all agree, else creator-chosen with the most-common member tz recommended (tie-break is a minor residual). Pinned thereafter (member-tz changes never shift it); re-settable, affecting only future buckets. Drives the group's `(subject_id, period, bucket_date, tz)` keys, calendar, and generation windows — the group analogue of the customer-level tz (RFC 0002).
- **Generation pulls from member DBs (Option B)** — for a group, each generation run **cross-reads the period window from every member database, combines in memory, and persists only the resulting report** into the group DB — over all four periods (LIVE / DAILY / WEEKLY / MONTHLY), non-retroactively from creation. Report *count* matches a single customer (one per period/bucket); member count does not multiply it. Consequences of Option B: raw events stay in member DBs (no duplication, isolation preserved); a single run pays a cross-DB read across all members (LIVE/DAILY are the costliest); and **re-generation / dirty recompute of a past window is bounded by member retention** (the *stored* result still survives per the group's own retention).
- **Group retention policy** — a per-group policy stored in the **auth DB, keyed by `subject_id`** (a peer of `customer_retention_policy`), **not** in the group's dedicated data DB. This matches the customer policy's location and the `subject_id` keying of `periodic_report_state`, and keeps the policy independent of group dedicated-DB provisioning so the group entity can own it before its data DB exists. (Implemented this way in #506; this supersedes an earlier draft that placed the policy "on the group database" — only the *policy row* moves to the auth DB, the group's generated reports still live in its dedicated data DB under Option B.) A report bucketed at `D` is reaped after **`D + min(group_policy_days, min_over_members(H_c))`**, `H_c = max(ingestion_days, coalesce(analysis_days, ∞))` per member (Option (a); NULL `analysis_days` = no expiry, member does not bound — see the P1 callout). Reaped past the bound, not kept as degraded display; the reaper runs before/with the member `event_redaction_map` sweep.
- **Permissions** — definition requires the **Manager or Analyst** role on **every** member customer; viewing requires the **report-read permission** on every member customer. Both resolve in the `general` auth context via `account_customer_memberships` (+ `analyst_customer_assignments`); the global System Administrator (`admin` context) has no per-customer data access and is not involved. A group's member set is constrained to customers the creator holds Manager/Analyst on.

---

## Open questions (to settle before scoping issues)

Several questions from earlier review are now **decided** and folded into the sections above:

- Permission model — define requires **Manager or Analyst on every member**; view requires the per-surface read permission (`reports:read` / `analyses:read`) on **every member**. Per-customer (`general`) roles only; the global System Administrator is not involved (it has no per-customer data access). The system has **no per-customer "Admin" role** — the per-customer roles are User / Manager / Analyst.
- Bridge sessions — behave like a normal sign-in (full scope parity; a bridge already opens a full aimer-web tab), so **no group-specific handling** and visibility follows the account's all-member permission. Lifting the current bridge restrictions to parity is an existing-behavior change tracked separately.
- Aggregation / group database — **Option B**: the group DB stores generated results only; each run pulls raw events from member DBs, combines in memory, and persists one aggregated report. A real aggregation over raw events (not a report-of-reports), with no raw-event duplication — chosen to preserve per-customer encryption isolation.
- Retention — a group report at bucket `D` is reaped after **`D + min(group_policy_days, min_over_members(H_c))`**, `H_c = max(ingestion_days, coalesce(analysis_days, ∞))` per member (Option (a); NULL `analysis_days` = no expiry, that member does not bound). Dropped, not degraded; the reaper runs before/with the member redaction-map sweep. Losing old group history is accepted to keep everything shown fully de-redactable and cross-customer sensitive data out of the group DB.
- Period model — **all four** periods (LIVE/DAILY/WEEKLY/MONTHLY).
- Timezone — a group has **its own stored timezone** (a tz-bearing subject, like a customer). Resolved **at creation**: if all members share one tz, use it automatically; if they differ, the creator must choose, with the **most common member tz recommended**. The stored value is **independent of later member-tz changes** (they never shift an already-set group tz); the creator can **re-set** it, and re-setting affects only **future** buckets — past reports keep the `tz` in their bucket key.
- Group cost — a group produces the same *number* of periodic reports as a single customer (one per period/bucket); member count does **not** multiply report **count**. But LLM input size and per-run cross-DB read **do** scale with member count and event volume, so "one more customer-equivalent" applies to row count only, not total cost.
- Cost guard — **light Option C** (preview + hard cap). At creation, show a **cost preview** of *result figures only* — member count, combined recent event volume, generation cadence (4 periods, recurring), and an estimated ongoing (monthly) token/cost figure — **without exposing the calculation method**, and clearly labelled as a **rough estimate**. Plus a **hard cap** on a light proxy (member count for v1) to block clearly-excessive groups. The Manager/Analyst gate controls *who*; the preview + cap control *how much*.
- Membership is **immutable** (no add/remove).
- Lifecycle — a group must always have a **manager** (Manager/Analyst on every member); never viewer-only. **Ownership** starts with the creator and, on owner departure, transfers to a remaining manager by a **deterministic rule** (Manager > Analyst, then oldest membership, then lowest account UUID); only the owner may manual-delete. **Auto-delete (DB torn down)** when the last manager is gone **or** any member customer is deleted. **Auto-suspend** (generation paused, existing reports read-only) when any member is `status='suspended'` or `database_status='failed'`; resumes when all members are active. Generation continues while any qualifying manager exists.
- Routing — **Alt 1**: full switch to `/subjects/[subjectId]` with a `subjects` supertype; `periodic_report_*` re-keyed to `subject_id` (free pre-release), customer deep-links preserved via a `/customers → /subjects` alias amending the RFC 0002 contract. Alt 2 (`/customers` + facade) rejected — it leaves two URL shapes/keyings and drift risk for only a short-term churn saving.
- Scope filter — defined groups appear as **presets**, which are purely a view filter over the cross-customer browse (select member customers), entirely distinct from opening the group's own report.
- Calendar — period-matched grid + retention boundary; hub keeps a short "recent" preview with the calendar as the path to history.

### Design decisions — all settled

All load-bearing decisions are now made (see the decided list above): data flow (Option B), routing (Alt 1), group timezone, retention bound (Option (a), defined computably), group lifecycle (incl. `database_status='failed'` treated as suspend), and the creation-time cost guard (light Option C). The RFC is ready to be split into implementation issues.

Smaller implementation residuals (settle while scoping, not blocking): the cross-DB read/fan-out mechanism and snapshot consistency across member DBs; the exact group-tz tie-break when no single member tz is most common; the event-volume vs member-count basis for the hard cap beyond v1; classifying member `status = 'disabled'` as suspend-like (pause) vs delete-like (cascade-delete); and confirming the re-generation bound (dirty recompute limited by member retention while the stored result persists per the group's own policy).

---

## Relationships

- **RFC 0002** (periodic LLM analysis) owns the report bucket model this RFC navigates and extends to groups.
- **RFC 0001** (analysis storage, redaction) owns the per-customer storage that group aggregation reads from.
- **#386** (periodic-report IA umbrella) is the existing information-architecture effort this navigation work belongs under.
- **`customer_retention_policy`** is the boundary authority for customer-subject temporal navigation; for a group it also sets `H_c = max(ingestion_days, coalesce(analysis_days, ∞))` per member (NULL `analysis_days` = no expiry), so a group report at `D` is reaped after `D + min(group_policy_days, min_over_members(H_c))` (retention decision, Option (a)).
- **RFC 0001 `event_redaction_map`** retention (kept only while a referencing row in *its* DB is retained) is the constraint that sets the group retention bound.
- **RFC 0002 deep-link contract** (`/customers/{customer_id}/analysis/story/{story_id}`, `/analysis/...`) is amended to make `/subjects` canonical, with a `/customers → /subjects` alias preserving existing aice-web-next links (Routing decision, Alt 1).
- **Bridge sessions** — decided: a bridge session should behave like a normal aimer-web sign-in (full scope parity), since it already opens a full aimer-web tab. Lifting the current scope-lock / cross-customer block (and reconsidering read-only) is an existing-behavior change tracked separately from this RFC; groups need no bridge-specific handling either way.

## Candidate implementation issues (to be written from this doc)

- [ ] Routing Alt 1: `subjects` supertype, re-key `periodic_report_*` on `subject_id`, move the **whole** analysis surface (hub + list + detail) to `/subjects/[subjectId]`, add a `/customers → /subjects` alias, and amend the RFC 0002 deep-link contract to name `/subjects` canonical.
- [ ] Group timezone — stored `tz` on the group: auto-adopt the shared member tz when all agree, else creator-chosen with the most-common member tz recommended; pinned against member-tz changes; re-settable (future buckets only). Keys `subject_id, period, bucket_date, tz`, calendar URLs, and generation windows.
- [ ] Group retention bound — reap a group report at bucket `D` after `D + min(group_policy_days, min_over_members(H_c))`, `H_c = max(ingestion_days, coalesce(analysis_days, ∞))` (NULL `analysis_days` = no expiry); clock on bucket date; run the reaper before/with the member `event_redaction_map` sweep; no degraded display.
- [ ] Group lifecycle enforcement — owner-based manual delete with deterministic auto-transfer (Manager > Analyst, then oldest membership, then lowest UUID) on owner departure; auto-delete when the last Manager/Analyst-on-all-members account is gone or a member is deleted; auto-suspend (generation paused, existing reports read-only) when a member is `status='suspended'` or `database_status='failed'`, resume when all members active. Requires re-evaluating the "manager exists" predicate on membership/role/customer-state changes.
- [ ] Creation-time cost guard — cost preview (result figures only: member count, combined recent event volume, generation cadence, estimated monthly token/cost; no method shown, labelled a rough estimate) + hard cap on member count (v1).
- [ ] Sidebar: expose summary subjects (customers, later groups) as first-class navigation; resolve the orphaned-hub entry-point gap.
- [ ] Report temporal navigation — period-matched calendar / date jump bounded by retention; hub keeps a short "recent" preview.
- [ ] Report temporal navigation — within-period prev/next on the detail page, with retention-boundary stop state.
- [ ] Data model: `customer_groups` (extends `subjects`) + immutable `customer_group_members`, types, and create/delete API (no membership edit).
- [ ] Group settings UI (define / delete only), gated on Manager or Analyst role on every member customer.
- [ ] Group dedicated-database provisioning (peer of per-customer DBs), results-only store; teardown on group delete.
- [ ] Group report-generation pipeline (Option B): cross-read member DBs at generation, combine in memory, persist only the result into the group DB, keyed by `subject_id`; all four periods, non-retroactive. Token-bearing inputs must reference member-side analysis/story-analysis rows (so `analysis_days` governs their map horizon); raw-event-only refs fall back to `ingestion_days` (see retention bound).
- [ ] Group analysis surface: render the group's report / story / event entries as **group-owned summary artifacts** stored in the group DB, with each entry's **source raw detail linking back to the owning member customer** (member DBs hold the raw story/event; the group DB never does).
- [ ] Group viewing authorization — per-surface read permission (`reports:read` / `analyses:read`) required on every member customer.
- [ ] Scope filter: expose defined groups as member-selection presets (pure view filter), distinct from the group hub.
