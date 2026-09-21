# 参与贡献

感谢你的关注。本项目最需要的贡献是**词典**，其次是 bug 报告与代码改进。

## 补词（最常见）

1. 用 cursor-zh 启动 Cursor，把想汉化的界面都点开一遍。
2. 在控制台按 `c` 回车（或运行 `cursor-zh.exe collect`），打开 `dict/untranslated.json`。
3. 逐条判断：
   - **界面文案**（按钮、标签、提示、设置项说明）→ 翻译后加入 `dict/zh-CN.json`。
   - **内容**（模型名、字体名、文件名、快捷键、shell 命令、你自己的对话标题）→ 不要加。
4. 放进合适的分组（`exact` 里以 `_` 开头的键是分组注释，可新增分组）。
5. 含数字或变量的文案写成正则模板放入 `patterns`：

   ```json
   { "match": "^(\\d+) files? changed$", "replace": "$1 个文件已更改" }
   ```

   注意 JSON 中反斜杠要写成 `\\d`。exact 命中优先于 patterns，所以高频的固定句子仍建议放 exact。
6. 本地校验：

   ```powershell
   npm install
   npm run build
   npm run validate-dict
   ```

7. 提 PR。CI 会再次校验 JSON 合法性、重复键、正则有效性，并跑端到端测试。

### 翻译风格

- 简体中文，术语与 VS Code 官方中文语言包保持一致（如"资源管理器"、"命令面板"、"源代码管理"）。
- `Agent` 译为"智能体"，`Chat` 为"对话"，`Plan` 模式为"计划"，`Worktree` 为"工作树"，`Allowlist` 为"允许列表"。
- 保留产品名和专有名词：Cursor、MCP、Tab、Git、PR、LSP、Max 模式。
- 中英文之间留一个空格（"Cursor 设置"），全角标点。
- 省略号保留原文形式（`...` 就写 `...`），因为引擎会自动处理尾部标点。
- 不确定的译法在 PR 中说明，宁可保留英文也不要猜。

## 报告问题

请附上：

- Cursor 版本（`Help → About`）与 cursor-zh 版本（`cursor-zh.exe version`）。
- `logs/cursor-zh.log` 相关片段。
- 若是某处没翻译：`collect` 导出的相关条目；若是翻错：截图与原文。

## 代码改动

- TypeScript 源码在 `src/`，注入到 Cursor 页面的脚本是 `inject/translator.js`（纯 JS，需保持幂等，且只能写 `nodeValue` 与普通属性——不要引入 `innerHTML`、`eval`、`new Function`，否则会撞上 Cursor 的 Trusted Types CSP）。
- 修改 `translator.js` 后请提升其内部 `VERSION`，这样热更新会替换页面里的旧实例。
- 跑 `npm run check` 与 `npm run test:e2e`。
- 涉及探测/启动逻辑的改动请在真机验证：用 `node dist/index.js start` 跑一遍（Cursor 在运行时会询问是否重启）。
- `cursor-zh.cmd` 必须保持纯 ASCII、CRLF 换行。cmd.exe 按字节偏移重读批处理文件，文件里一旦有 UTF-8 多字节字符，`chcp 65001` 之后解析位置就会错乱（在 GBK 控制台下会跳到错误分支、找不到标签、窗口直接关闭）。中文提示交给 Node 输出。测试时用 `cmd /c "chcp 936 >nul & cursor-zh.cmd"` 模拟中文系统的默认控制台，不要只在已是 UTF-8 的终端里验证。

## 设计边界（不接受的改动）

- 修改 Cursor 安装目录下的任何文件（`workbench.html`、JS 包、`product.json`）。
- 默认联网（自动检查更新、自动拉词典、遥测）。`update-dict` 必须保持手动触发。
- 调用在线翻译 API。
- 触碰 Cursor 的网络协议或账户系统。

这些边界是本项目"低风险"定位的基础。
