# Launch notes

This document contains a release checklist and draft posts for [Context Atlas](https://github.com/qsxustc/context-atlas). The configured demo address is [qsxustc.github.io/context-atlas](https://qsxustc.github.io/context-atlas/). Verify the deployed demo and review the released app before using any announcement. These are drafts, not messages sent to any community.

The SVG banner is an illustration of the product. Both READMEs include the actual desktop interface screenshot in `assets/demo.jpg`. Review any visual assets against the version being announced; no social-preview upload or community promotion is implied by their presence in the repository.

## Positioning

**One sentence:** Context Atlas is a local-first visual workbench for choosing repository files, fitting an estimated AI context budget, and exporting Markdown or XML.

**The problem:** Preparing context is a selection task. A repository's context costs are hard to see, and it is easy to include files that consume space without helping the model solve the task.

**The hook:** A treemap and a live estimated budget make the selection visible before you paste it into an AI assistant.

**Claims to keep:** Browser-only processing; no backend, tracking, external fonts, or API-key requirement; zero package dependencies; English and Chinese UI; token counts are estimates; secret redaction is best effort.

**Claims to avoid:** Guaranteed token accuracy, complete secret detection, universal folder support, “the first” repository context tool, guaranteed GitHub stars, or support for model APIs that the project does not integrate with.

## Release checklist

- Run `npm test` and `npm run build` from a clean checkout.
- Check the demo, folder loading, file search, selection, automatic fitting, redaction, both export formats, and both interface languages.
- Check the CLI example in the README against a small test repository.
- Check that the screenshot in both READMEs and any recordings match the released interface.
- Review the illustrative social-preview banner against the project's current positioning.
- Check documentation links before publishing an announcement.
- Confirm that exported examples and screenshots contain only synthetic or public code and no credentials.
- Review the MIT license and contribution instructions.
- Push the source to the intended public GitHub repository, with a clear description and relevant topics.
- If enabling GitHub Pages, set **Repository Settings → Pages → Source → GitHub Actions**, then push to `main` or manually run the Pages workflow. Verify the deployed site and asset loading under the repository's URL path.
- Verify the repository and demo URLs in the launch copy below.
- Use each community's current posting rules, disclose that you are the creator, and respond to technical feedback.

Suggested GitHub description:

> A local-first visual workbench for choosing repository context, fitting a token budget, and exporting Markdown or XML. Zero dependencies.

Suggested topics to consider: `ai`, `developer-tools`, `context-engineering`, `visualization`, `local-first`, `javascript`, `cli`.

## A short demo

Aim for a 20–30 second recording with readable text:

1. Open the built-in demo and pause on the treemap.
2. Search for a relevant module and select several files.
3. Reduce the budget and use automatic fitting.
4. Show the preview and redaction control.
5. Export a Markdown bundle.

Use synthetic demo content. Avoid opening a private local repository while recording. Add captions if the video has narration.

## Hacker News draft

Title:

> Show HN: Context Atlas – visually choose repository context for AI assistants

Body:

> I built Context Atlas because preparing code context often felt like guessing which files would fit and which ones mattered.
>
> It runs locally in the browser. Load a folder, inspect a treemap, select files, set an estimated token budget, and export Markdown or XML. There is a built-in demo and a small Node CLI, and neither the app nor its tooling needs package dependencies.
>
> The estimate is deliberately approximate, and secret redaction is best effort; the preview is there so you can review what you are about to share.
>
> Repository: [qsxustc/context-atlas](https://github.com/qsxustc/context-atlas)
>
> Demo: [Try Context Atlas](https://qsxustc.github.io/context-atlas/)
>
> I would appreciate feedback on the file-selection workflow, especially which kinds of repositories make a visual budget useful.

Before posting, verify the current Show HN requirements and use a working demo link if you have one.

## Reddit draft

Title:

> I built a local visual tool for deciding which repository files to send to an AI assistant

Body:

> I often wanted to give an AI assistant a focused slice of a repository, but found it hard to see how much context different files would consume.
>
> Context Atlas is a browser app that lets you load a local folder, inspect its treemap of estimated token costs, search and select files, and export a Markdown or XML bundle within an estimated token budget. It includes a demo, English/Chinese UI, and a Node CLI. There is no backend, tracking, or API-key requirement.
>
> Token counts are approximate and the optional local secret redaction is best effort, so exports still need a review before sharing.
>
> I am the creator. The project is MIT licensed: [qsxustc/context-atlas](https://github.com/qsxustc/context-atlas)
>
> Demo: [Try Context Atlas](https://qsxustc.github.io/context-atlas/)
>
> Which part of preparing repository context causes you the most friction: finding files, controlling size, or checking what gets included?

Choose a community that accepts this kind of project, review its current rules, and adapt the post to that community. Do not paste the same announcement across unrelated communities.

## 中文分享草稿

标题：

> 我做了一个可视化工具，帮你决定应该把哪些代码交给 AI

正文：

> 用 AI 处理代码问题时，一个常见难点是准备上下文：相关文件在哪、哪些可以省略、多少内容能放进模型窗口？
>
> 我做了 Context Atlas。它在本地浏览器里运行，加载文件夹后可以通过矩形树图查看代码库，搜索并勾选文件，控制估算的 token 预算，最后导出 Markdown 或 XML。带示例项目、中文/英文界面和 Node CLI，零第三方包依赖，也不需要 API Key。
>
> token 是粗略估算，脱敏是对常见密钥模式的尽力识别，分享前仍需要检查导出内容。
>
> MIT 开源：[qsxustc/context-atlas](https://github.com/qsxustc/context-atlas)
>
> 在线体验：[Context Atlas](https://qsxustc.github.io/context-atlas/)
>
> 欢迎试用，也想了解大家平时准备代码上下文时最费时间的一步。

## After release

Keep feedback grouped by the underlying problem: file discovery, budget behavior, export usability, browser compatibility, or redaction. Turn reproducible bugs into issues with small public examples.

Prioritize problems people encounter in actual use. Stars can help discovery, but they are an outcome of usefulness, clarity, distribution, and timing rather than a feature the project can promise.
