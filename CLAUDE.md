# Project guidelines

## Commit messages

- Title: preferably under 50 characters, start with imperative verb (e.g.,
  `Add`, `Fix`, `Remove`)
- Body: wrap at 72 characters, free-form, explain *why* not *what*
- Separate title and body with a blank line
- Reference issues: use `Closes #N` to close an issue, or `Part of #N` when
  the commit addresses part of an issue

## Attribution

- Do NOT add `Co-Authored-By` lines to commit messages.
- Do NOT add "Generated with Claude Code" or similar attribution to PRs or
  issues.

## Language

- Code, comments, commit messages, PR descriptions, and issues are written in
  English.

## Branching and pushing

- NEVER push directly to `main`. Always create a new branch before pushing.
- Branch names must follow the format `<github-username>/issue-#` (e.g., `alice/issue-42`).
  If there is no related issue, ask the user how to proceed before creating the
  branch.

## Package manager

- This project uses **pnpm** exclusively. NEVER use `npm`, `bun`, `yarn`, or
  any other package manager.
- Run CLI tools via `pnpm` (e.g., `pnpm vitest run`, `pnpm tsc --noEmit`,
  `pnpm biome check`). NEVER use `npx`.

## CI requirements

- Before committing, ensure all CI lint/check steps (e.g., Biome, type checks)
  would pass for the changed files.
- Before pushing or opening a PR, ensure the full CI pipeline passes locally
  (all checks, tests, and builds).

## Manual documentation

- A feature is not done until its manual page is written.
- Do not write docs for features still under active development.
- Keep the manual in sync with code — update docs whenever user-facing
  behavior changes.
- Every feature description must include UI screenshots.
- EN/KR pages must stay in sync (same structure, same filenames).
- See `docs/AUTHORING.md` for the full authoring guide.
