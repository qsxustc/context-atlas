# Architecture

Context Atlas is a static browser app and a Node CLI. Both use the same dependency-free analysis and export module. There is no application backend or external model integration.

## Modules

| File | Responsibility |
| --- | --- |
| `index.html` | Semantic page structure, controls, and export/help dialogs. |
| `src/app.js` | Browser state, folder import and drag-and-drop, file selection, search, previews, clipboard/download export, and UI events. Imported content stays in memory. |
| `src/core.js` | Path normalization, default/custom ignore rules, rough token estimation, file analysis, common secret-pattern detection and redaction, budget fitting, and Markdown/XML export. Shared by browser and CLI. |
| `src/import-utils.js` | Browser import preparation, default path filtering before the file-count cap, folder-relative paths, and scoping nested `.gitignore` patterns. |
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

The browser accepts UTF-8 text up to 1 MiB per file and 50 MiB in total, and imports at most 5,000 files. Default path filtering runs before the file-count cap so dependency folders do not crowd out source files. The CLI applies the same text-size limits without a file-count cap, skips symlinks, and reads `.gitignore` from the input root. Browser import can also resolve nested `.gitignore` patterns relative to their folders.

Ignore handling supports common glob patterns on a best-effort basis rather than all Git ignore semantics; built-in exclusions remain in force. Matching uses non-backtracking dynamic programming, skips rules longer than 2,048 characters, and evaluates at most 4,096 effective custom rules.

Selection uses a deterministic, greedy file-path heuristic. Project guidance, manifests, entry points, configuration, and source directories receive priority. It does not infer task relevance or construct a dependency graph.

Token estimates weight ASCII, CJK, and other Unicode characters differently. Selection cost conservatively includes export framing, file paths, Markdown fences, XML escaping, and both original/redacted content. The CLI also checks the final exported text against the requested estimated budget. Estimates are not model-specific tokenizer results.

Repository content is treated as text and rendered through text nodes or a textarea. Exports include a notice that repository files are untrusted context. Pattern-based redaction is useful preparation, but it cannot identify every secret or sensitive value.

## Verification and deployment

`npm test` runs Node's built-in test runner. Tests cover core behavior, treemap layout, and CLI/server behavior. `npm run build` produces `dist/`; `npm run preview` serves it locally.

The CI workflow tests and builds the project. The Pages workflow deploys the static build on pushes to `main` or manual dispatch. Before using it, set **Repository Settings → Pages → Source → GitHub Actions** in the published repository.
