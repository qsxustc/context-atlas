# Changelog

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
