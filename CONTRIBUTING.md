# Contributing to Context Atlas

Thanks for helping make repository context easier to understand and prepare.

## Get started

Use Node.js 20 or later. Clone the repository and run:

```sh
npm run dev
```

Open the URL printed by the server. There is no dependency installation step.

Before submitting a change, run:

```sh
npm test
npm run build
```

Use `npm run preview` to check the built static site.

## Report a bug

Use the bug report template and include the browser or Node version, the action that failed, and the expected result. A small synthetic folder that reproduces the issue is especially helpful.

Remove private source code, credentials, personal data, and private repository names from examples, logs, and screenshots before posting them in a public issue.

## Propose a feature

Explain the task you are trying to complete and where the current workflow falls short. A concrete example helps more than a broad request for more integrations.

For large changes, open an issue before investing substantial implementation time so contributors can discuss scope and tradeoffs.

## Make a change

- Keep changes focused on a single problem.
- Preserve the local-first workflow. Explain any new network behavior clearly in your proposal.
- Prefer the existing browser and Node APIs; the project intentionally has no package dependencies.
- Make controls usable with a keyboard and give them clear accessible names.
- Update both English and Chinese interface text when your change adds or changes user-facing strings.
- Keep token-estimation and secret-redaction claims accurate. Avoid implying model-specific token accuracy or complete secret detection.
- Update documentation when commands or user-visible behavior change.

For selection, budget, export, filtering, or redaction logic changes, add or adjust a test covering the behavior. For small copy or style edits, a visual check is usually enough.

## Submit a pull request

Describe the problem, the resulting behavior, and how you checked it. Include a screenshot when the change affects the interface. Mention any known limitations that a reviewer needs to understand.

Contributions are made under this repository's [MIT license](LICENSE).
