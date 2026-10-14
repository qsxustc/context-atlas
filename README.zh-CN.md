<p align="center">
  <img src="assets/social-preview.svg" alt="Context Atlas — 让 AI 上下文变得可见" width="960">
</p>

<p align="center">
  <strong>把 Git diff 变成可直接用于代码审查的上下文。</strong>
</p>

<p align="center">
  一个在本地运行的 AI 上下文工作台，帮助你在把代码交给 AI 之前，决定该提供哪些文件。
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="LICENSE">MIT 开源</a> · 零依赖 · 文件内容留在本地
</p>

<p align="center">
  <a href="https://qsxustc.github.io/context-atlas/">在线体验</a> · <a href="https://github.com/qsxustc/context-atlas">GitHub 仓库</a>
</p>

你已经知道要让 AI 解决什么问题，但一个代码库里可能有几百个文件：相关模块、生成文件、辅助工具，还有一个不知不觉占掉大量上下文的大文件。哪些应该放进去，哪些可以省略，往往需要反复判断。

**Context Atlas 把这个判断过程变成可视化操作。** 导入 Git diff，用 **Review Pack（审查包）** 将补丁、当前变更文件，以及相关依赖、引用方和测试放进同一个有预算限制的上下文包。也可以用 **Focus Mode（聚焦模式）** 围绕单个文件准备上下文。查看选择原因与缺失内容，再导出给你正在使用的 AI 助手。整个过程在本地完成。

把有用的选择保存为 **Context Recipe（上下文配方）**，下次重新载入仓库即可复用，并检查哪些文件发生了变化。配方可以在浏览器和 CLI 之间传递，让一次仔细挑选变成可重复使用的工作流。

<p align="center">
  <img src="assets/review-demo.jpg" alt="审查包汇集两个改动文件、依赖、引用方和测试，并计算完整上下文预算" width="1100">
</p>

### 可以做什么

- **准备 AI 代码审查。** 导入 Git diff，保留变更和当前变更文件，用剩余预算补充相关上下文，并在导出前检查文件缺失和补丁不匹配提示。
- **围绕一个文件准备上下文。** 聚焦模式分析支持的 JS/TS import 关系，找出引用该文件的模块和相关测试，并解释候选文件的来源。
- **跨会话复用上下文。** 将明确的文件路径、预算和导出格式保存为命名配方；再次应用时检查变化或缺失路径，还可以通过 JSON 在浏览器与 CLI 之间传递。
- **可视化浏览代码库。** 用矩形树图直观查看各文件的粗估 token 成本及分布。
- **精确选择上下文。** 搜索文件、逐个勾选，并查看选择对预算的影响。
- **控制输入预算。** 设置目标 token 数，用自动适配生成粗估预算内的文件选择。
- **分享前检查。** 预览上下文，并在本地对常见密钥模式进行脱敏。
- **导出文本。** 下载 Markdown 或 XML 上下文，接入你已经在使用的 AI 工作流。
- **直接试用。** 内置示例项目，无需先准备自己的代码库。
- **切换语言。** 界面支持 English 与简体中文。

应用完全在浏览器里运行，没有后端、追踪统计、外部字体，也不需要 API Key。Context Atlas 在本地读取仓库文件，不上传文件内容。源码和导入的补丁内容只保存在内存中；配方的名称、项目标签、路径、内容指纹、预算和导出格式保留在当前网站的浏览器存储中，直到删除配方或清除网站存储。配方不包含源码文本、补丁文本或从源码提取的凭据值。开发工具与 CLI 同样**没有第三方包依赖**。

### 保存上下文配方，下次继续使用

<p align="center">
  <img src="assets/recipe-demo.jpg" alt="上下文配方库展示已保存的四文件选择，以及另一配方的当前文件变化和缺失提示" width="1100">
</p>

1. 载入仓库，手动勾选文件，或通过聚焦模式、审查包准备选择。
2. 设置预算和导出格式，为选中文件保存一个名称，例如“存储模块修改”或“API 调试”。
3. 下次重新载入仓库后应用配方。Atlas 选择匹配的当前文件，并报告内容变化的路径，以及在当前导入规则下不可用的路径。
4. 检查报告并调整选择。需要刷新路径、设置和指纹基准时，主动用当前选择更新配方。
5. 导出配方 JSON 作为备份或用于 CLI，也可以导入其他会话创建的配方。

浏览器最多保存 **30 个配方**，保留范围是当前网站与浏览器配置。重新打开页面会恢复配方，但仍需重新导入仓库文件。应用配方读取当前文件内容，只有主动更新才会改变保存的基准。内容指纹用于提示变化，不能识别 Git 分支、验证文件真实性或保存历史版本。内容发生变化的可用文件仍会被选中；缺失路径会明确提示，不会被其他文件替代。

配方是**仅包含文件选择的快照**，要求至少选中一个当前文件。保存聚焦模式或审查包的选择时，只保留选中文件的路径，不保存重新计算依赖图的指令，也不保存原始 diff、审查说明或源码内容。再次应用来自审查包的配方，只导出当前文件；准备新的审查包时应导入新的 diff。配方 JSON 会透露文件名和自定义名称，分享前请检查这些元数据。详情见[配方行为与限制](docs/architecture.md#context-recipes)。

### 把代码变更变成审查包

1. [体验审查包示例](https://qsxustc.github.io/context-atlas/?review=demo)，或导入自己的本地仓库，选择 **审查一次变更**。
2. 粘贴或选择 Git unified diff 文件。Atlas 会识别变更路径，保留当前可用的变更文件，并推荐相关 JS/TS 依赖、引用方和测试。
3. 查看变更摘要、选择原因、预算遗漏，以及文件缺失或补丁不匹配提示。
4. 导出 Markdown 或 XML，包含过滤后的补丁、审查说明和选中的当前文件。补丁和文件内容默认都会对常见密钥模式脱敏。

在需要审查的仓库中生成补丁：

```sh
git diff --no-ext-diff --no-textconv HEAD > /tmp/change.patch
```

这条命令包含相对 `HEAD` 的已跟踪文件工作区变更，Git 不会将未跟踪文件加入结果。Atlas 读取导入目录中的当前文件，不应用补丁，也不切换版本。请导入与补丁新版本一致的工作区。出现不匹配提示表示被检查的 hunk 行与当前文件不同；没有提示也不代表整个仓库版本完全一致。补丁输入最多 1 MiB、500 个文件区段。二进制变更会被跳过，合并提交的 combined diff 和格式错误的输入会被拒绝。详情见[审查包的范围与限制](docs/architecture.md#review-pack)。

### 一分钟体验聚焦模式

1. [体验聚焦示例](https://qsxustc.github.io/context-atlas/?focus=src%2Flib%2Fstorage.ts)，或在示例项目中选中 `src/lib/storage.ts`，点击 **围绕此文件构建**。
2. Atlas 会找到它依赖的 `src/types.ts`、引用它的 `src/hooks/useNotes.ts`，以及 `tests/storage.test.ts`。
3. 检查选择原因，调整是否包含引用方和测试，并查看因预算不足而省略的文件。
4. 预览、复制或下载上下文，交给你使用的 AI 助手。

聚焦模式分析模块 import 关系，不推断函数调用，也不理解任务描述。导入分析支持 JavaScript、TypeScript，以及 JSX/TSX 和相应的模块扩展名。相关测试通过直接 import 或文件名匹配进行推荐，界面会说明匹配方式。修改预算或选项后可点击重新构建，也可以撤销到此前的选择，或继续手动勾选。未解析的引用和预算遗漏需要检查。处理陌生项目时，可先了解[分析范围与限制](docs/architecture.md#focus-mode)。

### 本地运行

需要 **Node.js 20 或更高版本**。克隆或下载仓库后运行：

```sh
git clone https://github.com/qsxustc/context-atlas.git
cd context-atlas
npm run dev
```

在浏览器中打开终端输出的地址即可，**不需要先执行 `npm install`**。

源码使用浏览器 ES Modules，需要通过 HTTP 服务加载。请使用自带开发服务器，不支持直接双击 `index.html` 以 `file://` 方式打开。

### 一分钟上手

1. 探索内置示例、选择本地文件夹，或把文件夹拖入应用。
2. 查看矩形树图，搜索与当前任务相关的文件。
3. 选中正在修改的文件，构建聚焦上下文，或手动勾选文件。
4. 设置估算的 token 预算，按需重新构建聚焦选择并检查遗漏。通用的自动适配功能仍然可用。
5. 查看预览与脱敏设置，导出 Markdown 或 XML。

建议在较新的桌面浏览器中使用文件夹选择器。文件夹拖放的支持程度取决于浏览器；拖放不可用时可改用选择器。

浏览器每次最多导入 **5,000 个可读取的文本文件**，单文件不超过 **1 MiB**，符合条件的文本总量不超过 **50 MiB**。默认排除规则、自定义忽略规则和文件校验先执行，通过后才计入 5,000 个文件的上限，因此被忽略的文件、二进制、超大文件和无效 UTF-8 不会挤占可用源码的名额。常见依赖目录、生成文件和凭据文件会被排除。

根目录与嵌套目录的 `.gitignore` 规则提供尽力支持。`cache/` 这类仅针对目录的规则不会排除名为 `cache` 的普通文件。默认排除规则仍然生效，并限制自定义规则的长度和数量。拖放导入最多枚举 **100,000 个条目**；浏览器每次接受的 `.gitignore` 文本总量不超过 **1 MiB**。如果触及限制或读取失败导致无法确认某个目录的忽略规则，该目录会被跳过。界面会提示导入受到限制。详情见[架构说明](docs/architecture.md)。

### CLI 用法

在终端中从本地仓库生成 Markdown 上下文文件：

```sh
node bin/context-atlas.js ./repo --budget 32000 --output context.md
```

XML 输出可以加上 `--format xml`。不指定 `--output` 时，内容写入标准输出。CLI 默认对常见密钥模式脱敏，可以用 `--no-redact` 关闭；运行 `node bin/context-atlas.js --help` 查看全部选项。

围绕一个指定文件构建上下文，路径相对于输入目录：

```sh
node bin/context-atlas.js ./repo --focus src/lib/storage.ts --budget 8000 --output storage-context.md
```

添加 `--no-callers` 可排除引用焦点文件的模块，`--no-tests` 可排除推荐的测试；这两个选项需要与 `--focus` 或 `--diff` 一起使用。聚焦导出不指定 `--budget` 时包含所有相关候选文件；指定预算时保留焦点文件，并根据剩余预算选择相关文件。如果焦点文件本身放不下，命令会在写入输出前报错。遗漏文件数和未解析引用数写入标准错误。

从 Git diff 文件生成审查包：

```sh
# 在需要审查的仓库中运行。
git diff --no-ext-diff --no-textconv HEAD > /tmp/change.patch
# 在 Context Atlas 目录中运行，./repo 指向上述仓库。
node bin/context-atlas.js ./repo --diff /tmp/change.patch --budget 16000 --output review.md
```

也可以直接通过管道传入补丁，将 CLI 路径替换为实际的 Context Atlas 路径：

```sh
git diff --no-ext-diff --no-textconv HEAD | node /path/to/context-atlas/bin/context-atlas.js . --diff - --budget 16000
```

`--diff` 与 `--focus` 不能同时使用。审查导出始终保留过滤后的补丁和当前可用的变更文件；预算也包含审查说明与可选的相关上下文。如果必须保留的内容放不下，命令会在写入输出前报错。不指定 `--budget` 时包含所有相关候选文件，`--no-callers` 和 `--no-tests` 可控制可选上下文。即使目录中已无当前文件，仅含删除的补丁也可以生成审查包。文件缺失、补丁不匹配、过滤的补丁路径、预算遗漏和未解析引用均以数量提示写入标准错误。

将浏览器导出或 CLI 创建的配方应用到本地仓库：

```sh
node bin/context-atlas.js ./repo --recipe storage.recipe.json --output storage-context.md
```

默认使用配方保存的预算和格式；显式传入的 `--budget` 与 `--format` 会覆盖它们。CLI 保留每个保存的路径，并导出其当前内容。指纹变化会以数量提示写入标准错误；路径缺失、被过滤或完整导出超过估算预算时，会在写入前报错。`--recipe` 不能与 `--focus`、`--diff`、`--no-callers` 或 `--no-tests` 同时使用。每次运行仍默认开启脱敏，配方不保存脱敏开关。

生成上下文包时，将最终选中的文件同时保存为可传递的配方：

```sh
node bin/context-atlas.js ./repo --focus src/lib/storage.ts --budget 8000 \
  --save-recipe storage.recipe.json --recipe-name "Storage context" --output storage-context.md
```

`--save-recipe` 也支持通用选择、`--diff` 和 `--recipe`；审查包只保存选中的当前文件，不保存补丁或生成的说明。`--recipe-name` 必须配合 `--save-recipe` 使用。没有显式指定预算、也没有继承配方预算时，保存操作会选择能容纳选中文件的预算，最低为 16,000 个估算 token。配方输入必须是有效 UTF-8 JSON 普通文件，输入 JSON 与序列化后的导出都不能超过 1 MiB；格式化会超限时，导出自动改用紧凑 JSON。不支持输入符号链接或标准输入。CLI 只允许覆盖已是有效配方的保存目标，并拒绝配方、补丁与输出目标之间的路径冲突。

不指定 `--focus`、`--diff` 或 `--recipe` 时，没有 `--budget` 就导出所有符合过滤条件的文件；指定预算时使用通用的文件路径选择规则。

CLI 跳过符号链接、过滤路径、二进制或非 UTF-8 文件，以及大于 1 MiB 的文件。它读取输入根目录的 `.gitignore`，每次最多处理 50 MiB 的符合条件文本，超出时可缩小输入目录。浏览器的 5,000 文件数量上限不适用于 CLI。`--output`、`--diff`、`--recipe` 和 `--save-recipe` 路径会从仓库扫描中排除，即使其父目录路径经过符号链接别名。补丁与配方输入必须是有效 UTF-8 普通文件，不能是符号链接。根目录的 `.gitignore` 如果不可读取、超限或为符号链接，导出会停止，以免在忽略规则未知时继续处理。运行信息写入标准错误，不会混入标准输出中的导出文本，便于管道调用。

需要直接生成上下文文件时可以使用 CLI；需要观察和调整文件选择时可以使用浏览器界面。

### 如何理解预算

token 数量是**粗略估算**，不是某个模型的真实 tokenizer 计算结果。预算包含导出文本的结构标记与文件标题。中文、源码、标点以及不同模型的切分方式都可能影响实际用量。请为任务说明、聊天历史和模型输出留出空间。

通用自动适配根据文件路径，优先考虑 README、配置、入口和源码文件；聚焦模式根据选中文件周围受支持的 import 关系选择文件；审查包则合并当前变更文件周围的这些关联。它们都不理解具体任务，预算也可能导致有用的依赖被省略。导出前仍需检查选择结果、预算遗漏和未解析引用提示。

本地脱敏针对常见凭据模式，不能保证识别所有密钥或敏感信息。载入其他项目或恢复示例项目时，脱敏会重新默认开启。交给其他服务之前，请检查导出的内容。

### 构建与验证

```sh
npm test
npm run build
npm run preview
```

测试使用 Node 内置测试运行器。构建产物位于 `dist/`，可以部署到静态网站托管服务；preview 命令用于在本地预览构建产物。

使用仓库自带的 GitHub Pages 工作流时，先在 **Repository Settings → Pages → Source** 中选择 **GitHub Actions**，再推送到 `main` 或手动运行部署工作流。

模块、数据流和输入限制的说明见 [docs/architecture.md](docs/architecture.md)，版本变更见 [CHANGELOG.md](CHANGELOG.md)。

### 项目定位

仓库上下文准备已有很好的开源工具，例如 [Repomix](https://github.com/yamadashy/repomix) 和 [Gitingest](https://github.com/coderamp-labs/gitingest)；也有 [Repo Atlas](https://github.com/rajathpi/repo-atlas) 这样的仓库可视化项目。

Context Atlas 专注于准备上下文时的选择过程：在可视化界面里查看文件、调整勾选范围，并在导出前了解估算成本。欢迎选择最适合自己工作流的工具，也欢迎一起完善这个项目。

### 参与贡献

欢迎提交 bug、改进无障碍交互、完善估算方式，或提出来自实际上下文准备流程的需求。开发流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。

发布检查清单和分享文案草稿见 [docs/launch.md](docs/launch.md)。

如果这个工具帮你更好地准备 AI 上下文，可以点一个 star，让更多人发现它。

### 许可证

[MIT](LICENSE)。你可以使用、修改，并在自己的项目中继续开发。
