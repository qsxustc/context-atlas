# Architecture

Context Atlas is a static browser app and a Node CLI. Both use the same dependency-free analysis and export module. There is no application backend or external model integration.

## Modules

| File | Responsibility |
| --- | --- |
| `index.html` | Semantic page structure, controls, and export/help dialogs. |
| `src/app.js` | Browser state, folder import and drag-and-drop, file selection, search, previews, clipboard/download export, and UI events. Imported content stays in memory. |
| `src/core.js` | Path normalization, default/custom ignore rules, rough token estimation, file analysis, common secret-pattern detection and redaction, budget fitting, and Markdown/XML export. Shared by browser and CLI. |
| `src/import-utils.js` | Browser import preparation, default/custom path filtering, bounded directory enumeration and ignore-file reads, folder-relative paths, and scoping nested `.gitignore` patterns. |
| `src/treemap.js` | Deterministic balanced slice-and-dice rectangle layout. The UI uses estimated file tokens as weights, with a minimum weight for tiny files. |
| `src/demo.js` | Synthetic Orbit Notes repository content, including a deliberately fake credential for trying redaction. Its code is displayed as text, never executed. |
| `src/i18n.js` | Chinese interface translations and dynamic English/Chinese messages. Static English labels live in `index.html`. |
| `src/style.css` | Design tokens, layout, responsive styles, and interaction states. |
| `bin/context-atlas.js` | CLI arguments, bounded local filesystem scanning, output writing, and diagnostics. Uses `src/core.js` for analysis and export. |
| `scripts/serve.mjs` | Local HTTP server for source development and `dist/` preview. |
| `scripts/build.mjs` | Copies the app and public assets into `dist/` for static hosting. |

## Data flow

```text
Browser folder picker / drag-and-drop          Node filesystem scan
                  │                                     │
                  └───────────────┬─────────────────────┘
                                  ▼
                    ignore and input-size checks
                                  ▼
                     analyzeFile → file records
                                  ▼
              manual selection / suggestSelection(budget)
                                  ▼
                 buildContext(format, redaction setting)
                         ┌────────┴────────┐
                         ▼                 ▼
                  browser preview    CLI file / stdout
                  copy / download
```

The browser imports at most 5,000 readable UTF-8 text files, with limits of 1 MiB per file and 50 MiB of text in total. It collects applicable ignore rules, applies default and custom path exclusions, and validates each candidate's size, NUL bytes, and UTF-8 encoding before counting it as an imported file. Ignored, unreadable, binary, oversized, and invalid UTF-8 files do not consume the readable-file allowance. Nested `.gitignore` patterns are scoped to their folders, and ignore files inside an already excluded directory cannot restore files from that directory.

Drag-and-drop enumeration has a separate limit of 100,000 entries, covering files and directories. The collector lists a directory's children before processing them so a `.gitignore` in a later reader batch still applies. If the listing is incomplete, partial results are accepted only when that directory's own `.gitignore` was found and successfully read; otherwise the directory is skipped because its rules may be missing. Browser imports accept at most 1 MiB of `.gitignore` text in aggregate. A directory whose ignore file is unreadable or exceeds the remaining allowance is also skipped. The UI reports that the import was limited; an import with no readable files preserves the current project.

The CLI applies the same 1 MiB per-file and 50 MiB total text limits without a file-count cap, skips symlinks, and reads `.gitignore` from the input root only. It resolves the output parent directory before scanning, so a previous export is excluded even if the output path uses a symlinked ancestor. Output files that are themselves symlinks are rejected.

Ignore handling supports common glob patterns on a best-effort basis rather than all Git ignore semantics; built-in exclusions remain in force. Matching distinguishes files from directories: `cache/` excludes a directory and its descendants but leaves a regular file named `cache` eligible, while a directory named `icons.png` can contain readable source files. Matching uses non-backtracking dynamic programming, skips rules longer than 2,048 characters, and evaluates at most 4,096 effective custom rules.

Selection uses a deterministic, greedy file-path heuristic. Project guidance, manifests, entry points, configuration, and source directories receive priority. It does not infer task relevance or construct a dependency graph.

Token estimates weight ASCII, CJK, and other Unicode characters differently. Selection cost conservatively includes export framing, file paths, Markdown fences, XML escaping, and both original/redacted content. The CLI also checks the final exported text against the requested estimated budget. Estimates are not model-specific tokenizer results.

Repository content is treated as text and rendered through text nodes or a textarea. Exports include a notice that repository files are untrusted context. Credential scanning starts at key boundaries to avoid repeatedly scanning suffixes of long property names; risk line numbers use a shared newline index. Pattern-based redaction is useful preparation, but it cannot identify every secret or sensitive value.

## Browser interaction and local serving

Individual file selection updates existing list and map controls rather than rebuilding them. Rendering that does replace controls restores keyboard focus where the corresponding file remains visible. The inspector reuses its displayed source when the active file and language have not changed.

The browser normalizes the budget to an integer between 500 and 2,000,000; blank or invalid values fall back to 16,000. Loading a new project or restoring the demo closes stale export previews and enables redaction again. The redaction setting can still be changed explicitly for the current project.

The development and preview server binds to `127.0.0.1`. It rejects traversal, hidden paths, and resolved paths outside the served root. A visible symlink to a hidden file or directory is also rejected after resolution; ordinary internal aliases remain usable.

## Verification and deployment

`npm test` runs Node's built-in test runner. Tests cover core behavior, import filtering and traversal, treemap layout, and CLI/server behavior. `npm run build` produces `dist/`; `npm run preview` serves it locally.

The CI workflow tests and builds the project. The Pages workflow deploys the static build on pushes to `main` or manual dispatch. Before using it, set **Repository Settings → Pages → Source → GitHub Actions** in the published repository.
