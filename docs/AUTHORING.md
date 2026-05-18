# Manual Authoring Guide

This guide defines the principles and conventions for writing and
maintaining the Aimer Web user manual. All manual authors — human and
AI agent alike — must follow these rules.

## When to write documentation

- **Do not write** manual content for a feature that is still under
  active development and whose UI or behavior is expected to change
  significantly. Writing documentation for an unstable feature wastes
  effort.
- **Do write** manual content as soon as the feature implementation
  is complete. A feature is not done until its manual page exists.
- **Keep the manual in sync with code.** Whenever code changes affect
  user-facing behavior or UI, the corresponding manual pages must be
  updated in the same PR or immediately after. If a feature is
  removed, the manual page must be removed or updated.

## Content requirements

### UI screenshots are mandatory

Every feature description must include actual UI screenshots. Text
alone is not sufficient. Screenshots help readers who are not yet
familiar with the interface.

- Place screenshots in `docs/assets/`.
- Use PNG for screenshots, SVG for diagrams.
- Use relative paths from the Markdown file
  (e.g., `![dialog](../assets/account-create.png)`).
- Update screenshots whenever the UI changes.

### Screenshot capture procedure

Capture screenshots through
`e2e/capture-manual-screenshots.spec.ts`. Do not introduce a parallel
capture path; add a new test case to that spec for each new image.

- **Viewport**: `1280×720` (the spec's `VIEWPORT` constant). The
  `mobile-menu.png` exception captures at `375×667` because the
  mobile navigation is only rendered at narrow widths.
- **`deviceScaleFactor`**: `0.75`. The browser re-rasterises at the
  lower DPI rather than down-sampling a high-DPI render, so text
  (including Korean glyphs) stays crisp at 1× zoom in the rendered
  manual.
- **Effective on-disk resolution**: `960×540` (or `281×500` for the
  mobile exception). This is roughly half the pixel area of a
  `1280×720` capture, which cuts LLM vision token cost per image by
  ~44%. Anthropic recommends a 1568 px max longest side; we stay
  comfortably under that ceiling.
- **EN / KO parity**: each capture slot produces two PNGs (image
  text is rendered through the app's i18n strings in the captured
  locale). Use locale-suffixed filenames like
  `admin-environments-thumbprint-confirm.en.png` /
  `…ko.png`, and drive the app in the matching locale before
  snapshotting.

The capture spec already declares
`base.use({ deviceScaleFactor: 0.75 })` at the top and passes the
same value into every explicit `browser.newContext(...)` call, so
contributors do not need to set the scale factor per test.

### Language parity

- Every page in `docs/en/` must have a corresponding page in
  `docs/ko/` (and vice versa).
- Section structure and heading hierarchy must match between
  languages.
- Keep the same filename across language directories.

## Markdown formatting

- Use **ATX headings** (`#`, `##`, `###`). Do not skip heading
  levels.
- Leave a **blank line** before and after headings, lists, code
  blocks, and tables.
- Indent nested list items with **4 spaces**.
- Limit list nesting to **3 levels**. If deeper nesting is needed,
  restructure into sub-sections.
- Wrap prose lines at **80 characters** for readability in diffs.
  (Tables and URLs may exceed this limit.)

## AI agent authoring

Manual content is authored by AI agents. This means:

- Write in a straightforward, consistent style that agents can
  maintain reliably.
- When creating an issue for a feature, include a task item for
  manual documentation so the agent picks it up.
- Follow all rules in this guide. The key rules are also in
  `AGENTS.md` and `CLAUDE.md` for automatic enforcement.

## Local preview

    # Install dependencies (one-time)
    python3 -m pip install mkdocs-material mkdocs-static-i18n mkdocs-with-pdf

    # Start the dev server
    mkdocs serve

Open <http://localhost:8000> to see the English manual.
Switch to Korean via the language selector in the header.

## Build

    mkdocs build --strict

The static site is generated in `site/`.

## PDF generation

    ./scripts/build-docs-pdf.sh en
    ./scripts/build-docs-pdf.sh ko

PDFs are written to `site/pdf/aimer-web-manual.{en,ko}.pdf`.

## MkDocs tooling maintenance

The manual is built with MkDocs 1.6.x + Material for MkDocs 9.x +
mkdocs-static-i18n.

### Known risks

- **MkDocs 2.0**: Not yet released, but the Material team has
  announced it will be incompatible with Material for MkDocs (plugin
  system removal, theme rendering changes, YAML to TOML config
  migration).
- **MkDocs 1.x maintenance**: The MkDocs project has been largely
  unmaintained since August 2024.
- **Zensical**: The Material team is building a ground-up replacement
  (Rust + Python, MIT license). It reads `mkdocs.yml` natively, so
  migration cost is expected to be low. As of March 2026 it is
  v0.0.28 — not production-ready.

### When to reassess

- Material for MkDocs drops MkDocs 1.x support (committed until
  November 2026).
- Zensical reaches 1.0 with feature parity.
- Any dependency becomes unmaintained or has unpatched security
  issues.

When reassessing, check:

1. Does `mkdocs build --strict` still pass?
2. Do the i18n plugin and PDF generation still work?
3. Is the GitHub Actions workflow compatible with the new versions?
4. Are there breaking changes in config format or plugin API?

See Discussion #57 for the full rationale.

## CI behavior for docs-only changes

The CI workflow (`.github/workflows/ci.yml`) uses `dorny/paths-filter`
to detect docs-only changes. When a commit modifies only documentation
files (`docs/`, `**/*.md`, `mkdocs.yml`, `.markdownlint*`), build,
test, and other code-related jobs are skipped. Only the change-filter
job itself runs.

This means docs-only PRs merge faster and do not consume CI resources
for unrelated checks. If your PR includes both code and docs changes,
all CI jobs run as usual.

## Docs PR checklist

Before submitting a docs PR, verify:

- [ ] `mkdocs build --strict` passes with no warnings
- [ ] Local preview (`mkdocs serve`) renders correctly
- [ ] EN/KR pages are in sync (same structure, same filenames)
- [ ] New pages are listed in `mkdocs.yml` nav for both languages
- [ ] No broken links or missing images
- [ ] UI screenshots are included for new or changed features
