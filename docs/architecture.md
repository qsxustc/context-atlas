# Architecture

Context Atlas is a static browser app and a Node CLI. Both use the same dependency-free analysis and export module. There is no application backend or external model integration.

## Modules

| File | Responsibility |
| --- | --- |
| `index.html` | Semantic page structure, controls, and export/help dialogs. |
| `src/app.js` | Browser state, folder import and drag-and-drop, file selection, search, previews, clipboard/download export, and UI events. Imported content stays in memory. |
| `src/core.js` | Path normalization, default/custom ignore rules, rough token estimation, file analysis, common secret-pattern detection and redaction, budget fitting, and Markdown/XML export. Shared by browser and CLI. |
| `src/dependencies.js` | Best-effort JS/TS import scanning and local module resolution. Builds dependency, imported-by, and unresolved-reference indexes without executing repository code. |
| `src/focus.js` | Shared focus planning: collect dependencies, direct imported-by modules, and related tests, then fit candidates around a retained root within the estimated budget. |
| `src/focus-ui.js` | Focus controls, English/Chinese reason labels, candidate/omission display, explicit rebuilding, undo, and worker request lifecycle. |
| `src/focus-worker.js` | Browser worker that caches the imported project graph and prepares focus plans away from the main UI thread. |
| `src/review-diff.js` | Bounded Git unified-diff parsing, path filtering, hunk validation, and diff-aware credential redaction. |
| `src/review.js` | Multi-file change planning, current-snapshot checks, review notes, token accounting, and Markdown/XML review export. |
| `src/review-ui.js` | Local patch paste/file input, change summary, explicit rebuild, selection reasons, warnings, and undo. |
| `src/review-worker.js` | Local diff parsing and review planning using a cached project dependency graph. |
| `src/review-demo.js` | A synthetic patch for the sample repository, opened directly through `?review=demo`. |
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
          manual selection / general fitting / focus or review planning
                                  ▼
                 buildContext / buildReviewContext(format, redaction setting)
                         ┌────────┴────────┐
                         ▼                 ▼
                  browser preview    CLI file / stdout
                  copy / download
```

The browser imports at most 5,000 readable UTF-8 text files, with limits of 1 MiB per file and 50 MiB of text in total. It collects applicable ignore rules, applies default and custom path exclusions, and validates each candidate's size, NUL bytes, and UTF-8 encoding before counting it as an imported file. Ignored, unreadable, binary, oversized, and invalid UTF-8 files do not consume the readable-file allowance. Nested `.gitignore` patterns are scoped to their folders, and ignore files inside an already excluded directory cannot restore files from that directory.

Drag-and-drop enumeration has a separate limit of 100,000 entries, covering files and directories. The collector lists a directory's children before processing them so a `.gitignore` in a later reader batch still applies. If the listing is incomplete, partial results are accepted only when that directory's own `.gitignore` was found and successfully read; otherwise the directory is skipped because its rules may be missing. Browser imports accept at most 1 MiB of `.gitignore` text in aggregate. A directory whose ignore file is unreadable or exceeds the remaining allowance is also skipped. The UI reports that the import was limited; an import with no readable files preserves the current project.

The CLI applies the same 1 MiB per-file and 50 MiB total text limits without a file-count cap, skips symlinks, and reads `.gitignore` from the input root only. It resolves the output and diff-input parent directories before scanning, so previous exports and raw patch inputs are excluded even if those paths use a symlinked ancestor. Output and diff-input files that are themselves symlinks are rejected. Unreadable, oversized, or non-regular root `.gitignore` files stop the command rather than silently discarding their rules.

Ignore handling supports common glob patterns on a best-effort basis rather than all Git ignore semantics; built-in exclusions remain in force. Matching distinguishes files from directories: `cache/` excludes a directory and its descendants but leaves a regular file named `cache` eligible, while a directory named `icons.png` can contain readable source files. Matching uses non-backtracking dynamic programming, skips rules longer than 2,048 characters, and evaluates at most 4,096 effective custom rules.

General automatic fitting uses a deterministic, greedy file-path heuristic. Project guidance, manifests, entry points, configuration, and source directories receive priority. Focus Mode provides a separate selection method based on local module relationships. Neither method infers the user's task.

Token estimates weight ASCII, CJK, and other Unicode characters differently. Selection cost conservatively includes export framing, file paths, Markdown fences, XML escaping, and both original/redacted content. The CLI also checks the final exported text against the requested estimated budget. Estimates are not model-specific tokenizer results.

Repository content is treated as text and rendered through text nodes or a textarea. Exports include a notice that repository files are untrusted context. Credential scanning starts at key boundaries to avoid repeatedly scanning suffixes of long property names; risk line numbers use a shared newline index. Pattern-based redaction is useful preparation, but it cannot identify every secret or sensitive value.

## Focus Mode

`buildDependencyGraph(files)` indexes local module relationships for JavaScript and TypeScript source files (`.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`). It recognizes static imports, re-exports, literal `import()` calls, and literal `require()` calls. Repository source is scanned as text, never imported or executed. Comments and ordinary string contents do not create graph edges.

Relative specifiers resolve against imported file paths using exact matches, common extension candidates, and directory `index` files. JavaScript extension specifiers can resolve to the corresponding TypeScript sources. Only files already accepted by the import/CLI filters are available to the graph. Imports that point to excluded or unavailable local files can therefore remain unresolved.

The root `tsconfig.json` (or `jsconfig.json` when no root TypeScript configuration exists) can provide `compilerOptions.baseUrl` and exact or single-wildcard `paths` mappings. Comments and trailing commas are accepted. Configuration reads are bounded to 131,072 characters, the first 128 alias entries, and the first 16 targets per alias. Invalid configuration and unsupported mappings are ignored; inherited and nested configurations are not merged.

This is best-effort lexical analysis rather than a compiler or a language server. Computed specifiers, template-string specifiers, framework transforms, package export maps, inherited configuration, and nested project configuration are outside the supported scope. JSX/TSX plain text that resembles an import or `require()` expression can produce false relationships because the scanner is not a full JSX parser. External packages are not read from `node_modules`. Unconfigured `@/`, `~/`, and `#` alias conventions produce an `unconfigured-alias` notice when they do not resolve through `baseUrl`. Other bare specifiers that cannot be resolved through the supported configuration, including scoped packages and other unknown alias conventions, are treated as external without a warning. A warning-free plan is therefore not a guarantee that every dependency was found. Relationships mean one module imports another; they do not establish function calls, runtime reachability, or semantic relevance. Other source languages can still be selected and exported, but their imports are not analyzed.

Source scanning is bounded to 1,048,576 characters, 100,000 lexical tokens, and 2,048 distinct import specifiers per source file. Import specifiers are limited to 2,048 characters. Reaching a source/token/import-count limit adds an analysis-limit diagnostic; malformed or unsupported syntax can still be skipped without a diagnostic.

`buildFocusPlan(files, graph, rootId, budget, options)` keeps the chosen root, traverses its dependency closure, and optionally adds direct modules that import the root. It also suggests tests that import the root or its dependencies, or whose filenames match them. Import-based and filename-based test reasons remain distinct. Filename matches are only suggestions and can include unrelated tests with a common basename. Dependencies of imported-by modules and suggested tests are not recursively expanded, so the plan is not a complete build graph.

The planner uses the same conservative export estimate as general selection. The focus root has priority, then related candidates are fitted deterministically; unused budget is not filled with unrelated files. The result includes reasons, selected/omitted candidates, estimated full-plan cost, and unresolved references for all candidates, including those omitted by the budget. No source contents are embedded in reason metadata. If the root exceeds the budget, the browser makes that shortfall visible and the CLI fails before writing output. Token estimates remain heuristic.

Browser analysis runs locally in a worker so imports can be scanned without blocking the interface. The worker caches the graph for the current project, and a failed or timed-out request clears that cache while preserving the previous selection. Changing options or budget requires an explicit rebuild. Undo restores the selection from before the current focus session; manual selection changes dismiss the old focus report. The built-in demonstration can be opened with `?focus=src%2Flib%2Fstorage.ts`; this selects a file in the synthetic sample and does not fetch repository content.

The CLI exposes `--focus <repository-relative path>`, with optional `--no-callers` and `--no-tests` switches. Without `--budget`, it includes all focus candidates. Counts of budget omissions and unresolved references go to standard error, keeping exported standard output usable in pipelines. The general CLI export behavior remains unchanged when neither `--focus` nor `--diff` is present.

## Review Pack

Review Pack prepares context for a change review from a user-supplied Git unified diff and the current imported repository. It does not run Git, apply a patch, fetch a repository, reconstruct historical sources, or contact an AI service. The browser accepts pasted or uploaded patch text; the CLI uses `--diff <file>` or `--diff -` for standard input. `--diff` cannot be combined with `--focus`.

`parseGitDiff(text, { patterns, blockedDirectories })` accepts at most 1 MiB of UTF-8 patch text and 500 file sections. It validates Git `diff --git` headers, safe repository-relative paths, hunk line counts and ordering, and supported modification/addition/deletion/rename metadata. Git-quoted UTF-8 paths are decoded. Combined merge diffs, unsafe paths, duplicate changed paths, and malformed/incomplete supported structures are rejected. Binary sections are skipped. A patch with no eligible text changes fails without replacing the existing selection or export.

Both old and new paths of a change pass default and applicable custom ignore rules. Blocked directories from the current import also exclude patch descendants. A rename from or into an excluded path is omitted in full. Path filtering applies to deleted files as well as files that still exist. Skipped metadata records paths and reasons but retains no patch content for those sections. Limits and ignore handling remain best effort as described above; parsing a diff does not make repository text trustworthy.

`buildReviewPlan(files, graph, parsed, budget, options)` uses available non-deleted changed files as roots. Every such changed file and the filtered patch are mandatory in the initial plan. The planner merges transitive local dependencies, optional direct modules that import changed files, and optional related tests, deduplicating shared context. It uses the same JS/TS relationship limitations as Focus Mode. Imports of deleted or missing modules cannot be recovered from old sources, so they do not create new dependency roots.

The planner compares each available changed file against the supplied new-side hunk lines. It warns when those lines differ, when a changed file is unavailable, or when a supposedly deleted path is still imported. This is a partial snapshot check: unchanged lines outside hunks, pure renames, file-mode changes, and branch identity cannot be verified. The patch and current source are both retained with warnings rather than pretending they represent a reconstructed Git checkout. A deletion-only patch can be exported without any current source files.

`buildReviewContext(files, selectedIds, plan, exportOptions)` generates review instructions, coverage and warning notes, and the accepted patch, then passes them through the shared Markdown/XML exporter alongside selected source files. Generated sections use a reserved path prefix that avoids collisions with actual repository paths. Notes identify the actual selected and omitted sources at export time. The diff and all repository-derived metadata are explicitly marked as untrusted context. No review or bug finding is generated by Context Atlas itself.

`calculateReviewSelection(files, selectedIds, plan)` reports current-file count separately from generated sections while including the patch, notes, and source framing in token and byte costs. Planning reserves the full notes and patch cost before fitting optional files. Costs consider original and redacted diff variants, Markdown fencing, and XML escaping. The browser shows a mandatory-content budget shortfall; the CLI fails before writing output when mandatory content cannot fit and additionally checks the final exported format. Counts remain estimates, not model-specific tokenization.

Diff redaction handles old and new hunk sides separately so `+` and `-` prefixes do not hide ordinary credential patterns. Private-key blocks are masked while preserving line prefixes and hunk counts. The shared exporter applies default redaction to both generated and current file content. `--no-redact` explicitly disables this export behavior. Pattern matching does not guarantee complete secret removal; users still need to inspect the result.

The browser performs parsing and graph planning in a local worker with project-specific cache reset and bounded request lifetime. Budget or option changes require explicit rebuilding; undo restores the selection from before review. The demo link `?review=demo` uses only synthetic local content. The CLI bounds patch reads to 1 MiB before parsing, requires valid UTF-8, refuses input-file symlinks, and excludes the canonical patch file from the repository scan so raw ignored sections cannot reappear as a selected source. Standard-error warnings contain counts; control characters are removed from error messages and destination labels.

A typical workflow is `git diff --no-ext-diff --no-textconv HEAD > /tmp/change.patch`, then `node bin/context-atlas.js ./repo --diff /tmp/change.patch --budget 16000 --output review.md`. Generate the patch in the repository being reviewed and import its matching working tree. That Git command compares tracked working-tree changes against `HEAD` and does not include untracked files. For pipelines, use `git diff --no-ext-diff --no-textconv HEAD | node /path/to/context-atlas/bin/context-atlas.js . --diff -`.

## Browser interaction and local serving

Individual file selection updates existing list and map controls rather than rebuilding them. Rendering that does replace controls restores keyboard focus where the corresponding file remains visible. The inspector reuses its displayed source when the active file and language have not changed.

The browser normalizes the budget to an integer between 500 and 2,000,000; blank or invalid values fall back to 16,000. Loading a new project or restoring the demo closes stale export previews and enables redaction again. The redaction setting can still be changed explicitly for the current project.

The development and preview server binds to `127.0.0.1`. It rejects traversal, hidden paths, and resolved paths outside the served root. A visible symlink to a hidden file or directory is also rejected after resolution; ordinary internal aliases remain usable.

## Verification and deployment

`npm test` runs Node's built-in test runner. Tests cover core behavior, import filtering and traversal, dependency scanning/resolution, focus planning, Git patch parsing/filtering/redaction, review selection/export, treemap layout, and CLI/server behavior. `npm run build` produces `dist/`; `npm run preview` serves it locally.

The CI workflow tests and builds the project. The Pages workflow deploys the static build on pushes to `main` or manual dispatch. Before using it, set **Repository Settings → Pages → Source → GitHub Actions** in the published repository.
