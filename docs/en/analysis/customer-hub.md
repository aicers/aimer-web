# Customer Hub

The customer hub is the entry point for a single customer's analysis
surfaces. It links to that customer's periodic reports, threat stories,
and suspicious events, so every individual analysis has a navigable home
rather than being reachable only by knowing its ID.

<!-- Screenshot placeholder (#392): customer hub page showing the
     Security Reports, Threat Stories, and Suspicious Events section
     cards. Capture from a stack with a real membership once available. -->

## Sections

The hub renders up to three section cards, each linking into a list:

- **Security Reports** — the periodic report index (see [Periodic
  Security Reports](reports.md)).
- **Threat Stories** — the customer-scoped [threat stories
  list](threat-stories.md).
- **Suspicious Events** — the customer-scoped [suspicious events
  list](suspicious-events.md).

## Access control

The hub is **member-gated, section-by-section**:

- The **Security Reports** section renders only when the caller has
  `reports:read`.
- The **Threat Stories** and **Suspicious Events** sections render only
  when the caller has `analyses:read`.

A caller with only some of these permissions sees only the permitted
sections; the rest are hidden (not shown as disabled). A member with
none of them still reaches the hub — it shows an "no accessible
sections" notice rather than an error.

The hub itself returns `404` only when the caller is **not a member of
the customer at all** (existence-hiding, uniform with the report and
analysis pages). A rejected bridge session returns a real `403`: these
single-customer surfaces are not readable under a bridge.
