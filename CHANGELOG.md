# Changelog

## 0.3.0 — 2026-10-14

- Add Review Pack: import a Git unified diff and combine the filtered patch, current changed files, and related JS/TS dependencies, imported-by modules, and tests in one review context bundle.
- Show change status, additions/deletions, selection reasons, omitted context, missing current files, and patch/current-snapshot mismatches. Include review instructions and source-coverage notes in Markdown/XML exports.
- Reserve budget for the patch, review notes, and available changed files before fitting optional related sources. Allow deletion-only reviews without current files; fail CLI exports before writing when mandatory content cannot fit.
- Parse supported Git text patches locally with path validation, ignore filtering, a 1 MiB input limit, and a 500-file limit. Redact credential patterns on both sides of diff hunks while preserving hunk structure.
- Add CLI `--diff <file|->` for file or standard-input patches, with `--no-callers` and `--no-tests` options shared with Focus Mode. Exclude raw patch inputs from repository scans, including paths through symlinked parents.
- Add a browser review workflow and built-in demo at `?review=demo`, with local worker processing, explicit rebuild, and selection restore.
- Fail closed when the CLI root `.gitignore` cannot be read safely, and strip terminal control characters from CLI diagnostics.

Review Pack prepares context; it does not apply patches, check out revisions, or perform an AI review. Snapshot checks cover supplied new-side hunk lines and deletion absence only. Import analysis and secret redaction remain best effort.

## 0.2.0 — 2026-10-14

- Add Focus Mode: choose a file and build context from its local dependencies, modules that import it, and related tests.
- Explain candidate relationships, distinguish import-based and filename-based test suggestions, and show files omitted by the estimated token budget.
- Analyze supported JavaScript/TypeScript imports locally with no parser package, backend, or external API. Report unresolved references and analysis limits.
- Keep the focus file in the plan and make budget shortfalls visible instead of silently replacing it with smaller files.
- Run browser analysis in a local worker; provide explicit rebuilding, selection restore, and a shareable link to the built-in Focus demo.
- Add CLI `--focus <path>`, `--no-callers`, and `--no-tests` options using the same analysis and planning logic as the browser. Focus exports without a budget include related candidates only.

Import analysis is best effort, test filename matches are suggestions, and relationships describe module imports rather than function calls. Review the resulting selection before sharing.

## 0.1.1 — 2026-10-14

- Apply default and custom ignore rules before the browser's 5,000-readable-file limit. Binary, oversized, unreadable, and invalid UTF-8 files no longer use that allowance.
- Fix directory-only ignore rules matching regular files, and preserve source files inside directories with names such as `icons.png`.
- Bound drag-and-drop enumeration to 100,000 entries and accepted ignore-file text to 1 MiB in total. Skip directories whose ignore rules could not be determined and report limited imports.
- Preserve keyboard focus during file selection and map updates; update existing controls for individual selections and reuse unchanged source previews.
- Normalize invalid or fractional browser budgets and enable export redaction again when loading a project or restoring the demo.
- Avoid repeated credential-scanner work on long property names.
- Exclude previous CLI output when its parent directory uses a symlink alias.
- Prevent the local development and preview server from exposing hidden files through visible symlinks.

Token counts remain rough estimates, automatic fitting remains a file-path heuristic, and exported content still needs review before sharing.

## 0.1.0 — 2026-10-14

- Initial public beta: local browser repository import, token-weighted treemap, budget fitting, common-secret redaction, Markdown/XML export, English/Chinese interface, and a dependency-free CLI.
