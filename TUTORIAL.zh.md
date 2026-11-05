# DSH 插件开发、调试、GitHub 开源与 npm 发布实战教程

本文以真实插件 **dsh-workspace-memories** 为例，完整记录从需求分析、插件编写、安装验证、问题排查，到 GitHub 开源、npm 手动发布和 GitHub Actions 自动发布的过程。

- 插件仓库：<https://github.com/lengfengng-tech/dsh-workspace-memories>
- npm 包：<https://www.npmjs.com/package/dsh-workspace-memories>
- 当前已核实版本：`1.1.2`
- 插件形态：纯 JavaScript、无构建步骤、Host + Client 双面 DSH bundle

> 阅读建议：想照着重做一个插件，按第 1～10 章顺序操作；只想发布已有插件，直接看第 11～14 章；遇到报错，先查第 15 章“踩坑记录”。

---

## 1. 先明确插件要解决什么问题

这次的需求不是“做一个记忆文件列表页面”这么简单，而是形成一个完整的记忆闭环：

1. 每个工作区拥有独立的 Markdown 记忆文件；
2. 侧栏新增「工作区记忆」入口，可新建、查看、编辑、删除文件；
3. 在该工作区运行的 Agent 自动获得这些记忆；
4. 用户说“记住：……”时，Agent 能主动写入记忆；
5. 默认记忆不放在项目目录中，避免服务器配置、本机环境信息被误提交进 git。

由此拆成三个功能面：

| 功能面 | 实现 |
|---|---|
| 面板管理 | Client 侧栏入口 + 主面板 + Host HTTP CRUD API |
| 自动回忆 | `agent/created` 时为 Agent 注册 system-prompt section |
| 主动记忆 | 注册全局工具 `save_workspace_memory` |

存储支持两种模式：

| 模式 | 位置 | 用途 |
|---|---|---|
| `home`（默认） | `~/.dsh/workspace-memory/<workspace-key>/` | 本机配置、服务器拓扑、个人约定，不进项目仓库 |
| `workspace` | `<workspace>/.dsh/memory/` | 希望随项目版本化的团队共享记忆 |

> 安全提醒：记忆会进入模型上下文，不要把真实密码、访问令牌、私钥等直接写进去。服务器配置可以记地址、用途和排障方式，凭证本身应交给专门的凭据管理设施。

---

## 2. 先理解 DSH 插件的三个组成部分

一个可安装插件不是单独一个 JS 文件，而是一个 **bundle 包**：

```text
dsh-workspace-memory/
├── package.json          # npm 包信息 + DSH bundle/client 声明
├── cordis.patch.yml      # 向 DSH 组合插入哪个插件、传什么配置
├── index.js              # Host 半端：服务、路由、事件、工具
├── client.js             # Client 半端：浏览器里的 UI 和 slot 注册
├── locale/
│   ├── en.json
│   └── zh.json           # 插件管理页的中英文标题与描述
├── icon.svg              # 插件图标
├── README.md
├── README.zh.md
├── LICENSE
└── selftest.mjs          # 本地自测，不发布到 npm
```

三者职责不要混淆：

- `package.json`：说明“这个包叫什么、导出什么、是不是 DSH bundle”；
- `cordis.patch.yml`：说明“安装后往当前 profile 的组合里加入什么”；
- `index.js` / `client.js`：真正的功能代码。

本插件没有 TypeScript 和构建步骤，因此 GitHub 安装和本地目录安装都不需要执行 `prepare`/`build`。

---

## 3. 不要凭猜写 API：先检查运行时

本次开发先使用 DSH 自带的只读检查工具确认了实际可用能力：

```text
cordis_inspect_list
cordis_inspect_query
```

重点检查了：

- Client `Slots.listSubTree`：找到 `sidebar.panellist` 和 `main`；
- Client `Theme.listTokens`：确定主题变量；
- Host `Service`：确认 `connection`、`workspaceRegistry`、`systemPrompt`、`tools`、`sessions`；
- Host `Event`：确认 `agent/created` 的触发方式；
- Host `Tool.listTools`：后续验证工具是否注册成功。

建议的固定顺序：

1. `cordis_inspect_list` 获取 provider 列表；
2. `cordis_inspect_query` 查询目标 slot/service/event 的精确契约；
3. 再阅读对应包的 README 或源码；
4. 最后写代码。

这样能避免“文档里有这个 API，但当前版本其实不一样”的问题。

---

## 4. 编写 bundle 清单和 patch

### 4.1 `package.json`

核心字段如下（完整文件以仓库为准）：

```json
{
  "name": "dsh-workspace-memories",
  "version": "1.1.2",
  "type": "module",
  "license": "MIT",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": [
    "index.js",
    "client.js",
    "cordis.patch.yml",
    "locale/*.json",
    "icon.svg",
    "README.md"
  ],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar",
        "@deepseek-ai/dsh-client-ui-workspace",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  }
}
```

关键点：

- `dsh.bundle.patch` 让它成为可启用的 DSH bundle，而不是普通 npm 依赖；
- `dsh.client` 让 DSH 发现并服务浏览器半端；
- `exports["./client"]` 必须指向浏览器入口；
- `files` 是 npm 发布白名单，避免把自测和临时文件发出去；
- npm 会自动包含 README、LICENSE 等标准文档，但运行时文件仍应明确列入 `files`。

### 4.2 `cordis.patch.yml`

```yaml
- insert:
    - id: workspace-memory
      name: 'dsh-workspace-memories'
      config:
        storage: home
        storageDir: !!js dshHomePath('workspace-memory')
```

- `id` 是组合里的插件行 ID；
- `name` 必须与 npm 包名一致；
- `dshHomePath(...)` 让存储根目录跟随 DSH home，而不是写死某个用户路径；
- 用户若要项目内存储，可在自己的 profile 覆盖为 `storage: workspace`。

---

## 5. Host 半端：API、记忆注入和 Agent 工具

Host 入口导出：

```js
export const name = 'workspace-memory'
export const inject = [
  'connection',
  'workspaceRegistry',
  'systemPrompt',
  'tools',
  'sessions',
]

export function apply(ctx, config = {}) {
  // 注册路由、事件和工具
}
```

### 5.1 浏览器与 Host 的通信

本插件没有引入 Typert 代码生成，而是使用 Connection 的精确 Fetch 路由：

```js
ctx.effect(() => ctx.connection.fetch.register({
  path: '/api/workspace-memory/list',
  methods: ['GET'],
  requestBody: 'buffered',
  fetch: handleList,
}), 'workspace-memory: list route')
```

四条路由：

```text
GET  /api/workspace-memory/list?workspaceId=<id>
GET  /api/workspace-memory/read?workspaceId=<id>&name=<file>
POST /api/workspace-memory/write   { workspaceId, name, content }
POST /api/workspace-memory/delete  { workspaceId, name }
```

浏览器通过同源 `fetch('/api/workspace-memory/...')` 调用，认证由 DSH Connection 通道处理。

统一响应格式：

```json
{ "ok": true, "value": {} }
```

或：

```json
{ "ok": false, "error": { "code": "...", "message": "..." } }
```

安全措施：

- 只接受已注册工作区的 `workspaceId`，不让浏览器传任意文件路径；
- 工作区路径经 `workspaceRegistry` 解析；
- 文件名拒绝路径分隔符、`..`、空白和控制字符；
- 内容上限 1 MiB；
- 每个处理器统一捕获异常并返回结构化错误。

### 5.2 自动注入工作区记忆

监听：

```js
ctx.on('agent/created', ({ agent }) => {
  // 从 agent.session.header.cwd 找到工作目录
  // 解析工作区对应的记忆目录
  // 在 agent.ctx.systemPrompt 上注册 section
})
```

这里有几个重要设计点：

1. **按 Agent 注册**：section 注册在 `agent.ctx`，不同工作区互不影响；
2. **同步 text provider**：prompt section 的 `text()` 是同步函数，不能每次异步读文件；
3. **签名缓存**：用“文件名 + 大小 + mtime”组成目录签名，没变就复用缓存，变了才重读；
4. **限制体积**：单文件最多注入 32K 字符，最多 20 个文件；
5. **双重清理**：Agent 自己释放时会清理，插件也保存 disposer，保证插件卸载时能清理；
6. **监听绝不抛出**：`agent/created` 监听器里的异常可能破坏 Agent 创建，必须容错。

### 5.3 注册写记忆工具

工具名：

```text
save_workspace_memory
```

参数：

```json
{
  "name": "architecture",
  "content": "# 决策\n\n……"
}
```

行为：

- 自动补 `.md` 后缀；
- 复用与面板一致的文件名校验；
- 按调用 Agent 的工作目录定位记忆目录；
- 写入后，下一次 prompt 组装即可看到新内容；
- 工具注册在根组合，因此标准、PTC、极简、创造等预设默认都可见。

---

## 6. Client 半端：侧栏入口与管理面板

浏览器模块采用 DSH Module Loader 格式：

```js
window.__ModuleLoader__.load({
  id: 'dsh-workspace-memories',
  factory(require) {
    const React = require('react')

    return {
      inject: ['slots', 'locale', 'workspaces', 'sessions'],
      apply(ctx) {
        // 注册 slot
      },
    }
  },
})
```

注意：`id` 必须与包名一致。改包名时，这里也要改。

### 6.1 注册侧栏入口

```js
ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
  name: 'sidebar.panellist',
  id: 'workspace-memory',
  order: 20,
  locale: 'workspaceMemory',
  label: () => t('panel.title'),
}, MemoryPanelIcon))
```

### 6.2 注册同名主面板

```js
ctx.slots.inject('main', () => ctx.slots.register({
  name: 'main',
  key: 'workspace-memory',
  locale: 'workspaceMemory',
}, WorkspaceMemoryPanel))
```

侧栏条目 ID 与 `main` 的 key 必须一致，否则点击侧栏找不到主面板。

面板功能：

- 工作区选择器，默认选中当前会话所属工作区；
- 文件列表展示名称、大小、更新时间；
- 新建、读取、保存、删除、刷新；
- 删除二次确认；
- 进入面板自动打开第一个记忆文件；
- 删除后自动打开剩余的第一个文件；
- 中英文界面文案。

### 6.3 样式只使用主题 token

不要直接依赖宿主 React 组件包，也不要复制一套 React。React 来自：

```js
const React = require('react')
```

按钮主色应使用宿主按钮语义的 token：

```css
.dwm-button--primary {
  background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary));
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-bg-base));
}
```

而不是简单写死白底白字。

---

## 7. 本地测试：先验证逻辑，再安装

### 7.1 语法检查

```sh
node --check index.js
node --check client.js
```

这一步曾直接发现文件名正则中的非法字符区间问题，所以应在安装前执行。

### 7.2 Host 自测

```sh
node selftest.mjs
```

自测通过 mock `ctx`，覆盖：

- 4 条路由是否注册；
- 工具和 `agent/created` 监听是否注册；
- 空目录列表；
- 未知工作区；
- 写入、读取、列表、删除；
- 非法文件名；
- prompt 注入文本；
- Agent 工具写入及新内容可见；
- `home` 和 `workspace` 两种存储模式；
- 非法 `storage` 配置。

这类自测不需要启动完整 DSH，但能先排除大多数业务逻辑错误。

---

## 8. 安装到当前 DSH

### 8.1 通过插件管理工具安装

本次使用：

```text
plugin_manager
  action: install_bundle
  target: /Users/hxq/Desktop/test_ai/dsh-workspace-memory
```

成功结果应包含：

```json
{
  "application": "applied",
  "changed": true,
  "enabled": true
}
```

本地目录会以 `link:` 形式安装。

### 8.2 其他安装方式

GUI：

```text
侧栏「插件」→「添加插件」→ 输入包名、GitHub 地址或本地绝对路径
```

CLI：

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-workspace-memory
```

不要手工修改 profile 的 `package.json`、`cordis.patch.yml`，也不要在 profile 目录里自行跑 pnpm；交给插件管理器处理。

### 8.3 验证不是只看安装成功

安装后做了三层验证：

1. Host 条目存在且激活；
2. `sidebar.panellist` 和 `main` 中存在 `workspace-memory`；
3. `save_workspace_memory` 出现在工具列表中。

另外通过真实会话写入记忆，再检查磁盘文件，完成端到端验证。

> `Config.listConfigs` 中的 `status: absent` 只表示没有声明 Config schema，不表示插件未激活。

---

## 9. 开发期 HMR 与重启边界

本地 `link:` 开发时：

| 修改内容 | 生效方式 |
|---|---|
| `client.js` | 通常经 Client HMR 热更新 |
| `index.js`（Host） | 需要重启 DSH，加载新的 JS 模块代际 |
| 改包名 | patch、client module id、安装记录都要同步 |
| 移动/重命名安装目录 | 先移除旧 bundle，再从新路径安装 |
| 改 `files`、README | 不影响运行，只影响文档和打包 |

“禁用再启用 bundle”不一定能替换已经加载的 Host 模块，不能把它当作通用热更新手段。

---

## 10. 为什么 PTC 会话有时“找不到工具”

这是本次最容易误判的问题。

现象：

- Host `Tool.listTools` 已经能看到 `save_workspace_memory`；
- PTC 会话却说自己没有该工具；
- 但它通过代码按名字调用又能成功。

根因：

1. 工具注册表是即时更新的；
2. 模型看到的工具声明是在**每一轮对话开始时组装**的；
3. PTC 模式还会生成 TypeScript `ToolArgsMap` 绑定；
4. 如果当前轮早于插件安装/重载开始，本轮声明就是旧的，但实际 Host 分发已经能用新工具。

处理：

- 等当前轮结束后发新消息，或新开一个会话；
- 新一轮会重新生成声明；
- 不需要“探测式调用”。

这属于声明快照时序问题，不是工具只在某些模式可用。

---

## 11. GitHub 开源准备

### 11.1 命名与品牌

遵循 DSH 品牌指南：

- 项目名使用缩写 **DSH**；
- 不直接把完整商标 “DeepSeek Harness” 用作项目名；
- 描述中可以写 “built on DeepSeek Harness”；
- 明确标注“社区插件，非官方产品”；
- 可使用 `powered_by-dsh` 徽标链接到官方仓库。

### 11.2 必备文件

- `README.md`：英文主文档；
- `README.zh.md`：中文文档；
- `LICENSE`：MIT；
- `.gitignore`：忽略 `node_modules/`、`*.tgz`、`.DS_Store`；
- `package.json`：补齐 `license`、`keywords`、`repository`、`homepage`、`bugs`。

README 不只写“怎么用”，还写了“为什么做”：

- Agent 跨会话失忆；
- AGENTS.md 是静态项目说明；
- 有些记忆不应进入项目目录；
- 因此提供项目外、可写、可注入、可管理的工作区记忆。

### 11.3 使用 gh 创建并推送仓库

安装登录：

```sh
brew install gh
gh auth login
```

创建并推送：

```sh
cd /path/to/dsh-workspace-memory

git init -b main
git add -A
git commit -m "Initial release: workspace memory plugin for DSH"

gh repo create dsh-workspace-memories \
  --public \
  --description "Per-workspace persistent memory plugin for DeepSeek Harness (DSH)" \
  --source=. \
  --push
```

添加 topics：

```sh
gh repo edit <owner>/dsh-workspace-memories \
  --add-topic deepseek-harness,dsh,dsh-plugin,cordis,agent-memory,ai-agent,llm,deepseek
```

如果仓库或组织改名：

```sh
git remote set-url origin git@github.com:<new-owner>/dsh-workspace-memories.git
```

同时更新 `package.json` 中的 `repository`、`homepage`、`bugs`，避免 npm 页面指向旧地址。

---

## 12. 第一次手动发布 npm

### 12.1 注册并登录

在 <https://www.npmjs.com/signup> 注册账号并完成邮箱验证，然后：

```sh
npm login
npm whoami
```

`npm whoami` 能返回用户名才说明登录成功。

### 12.2 先检查包名是否被占用

```sh
npm view dsh-workspace-memory version
```

本次发现 `dsh-workspace-memory` 已被别人占用，因此改为：

```text
dsh-workspace-memories
```

改包名不能只改 `package.json`，还要同步：

- `cordis.patch.yml` 的 `name`；
- `client.js` 的 Module Loader `id`；
- README 安装命令和 npm 徽标；
- 本地 DSH 安装记录；
- 如需保持一致，GitHub 仓库名和 remote URL 也同步修改。

候选名可批量检查：

```sh
npm view dsh-workspace-memories version
```

查不到通常表示可注册；发布前仍应以 npm 实际响应为准。

### 12.3 发布前 dry-run

```sh
cd /path/to/dsh-workspace-memory
npm publish --dry-run --access public
```

重点检查：

- 包名和版本；
- Tarball Contents；
- 是否误带自测、密钥、临时文件；
- 是否漏掉 `client.js`、locale、patch、icon 等运行时文件。

本次发布包只有运行和文档所需文件，`selftest.mjs` 没有进入 tarball。

### 12.4 开启 2FA 后发布

npm 当前要求发布操作具备两步验证，或使用允许绕过 2FA 的 granular access token。个人首次发布建议直接开启 2FA：

1. 登录 npmjs.com；
2. 进入 Account → Two-Factor Authentication；
3. 启用 2FA，并确保写操作也受保护；
4. 在终端执行：

```sh
npm publish --access public
```

按提示输入验证器中的 6 位动态码。

发布后验证：

```sh
npm view dsh-workspace-memories version
npm view dsh-workspace-memories dist-tags
```

---

## 13. 用 GitHub Actions 自动发布（Trusted Publishing）

手动发布成功后，仓库进一步配置了 npm **Trusted Publishing**：发布 GitHub Release 时，由 GitHub Actions 通过 OIDC 发布 npm，不在 CI 中保存长期 npm token。

### 13.1 npm 侧配置

在 npm 包的 Trusted Publisher 设置中，绑定：

- GitHub owner / organization；
- repository；
- workflow 文件名：`.github/workflows/publish.yml`；
- 如使用 environment，还要保持 environment 名一致。

Trusted Publishing 不是“只放 workflow 就自动生效”，npm 包与仓库的绑定关系必须正确。

### 13.2 当前 workflow

文件：`.github/workflows/publish.yml`

```yaml
name: Publish to npm

on:
  release:
    types: [published]

permissions:
  id-token: write
  contents: read

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          registry-url: https://registry.npmjs.org

      - run: npm install -g npm@latest
      - run: npm --version
      - run: npm publish --access public --provenance
```

说明：

- `release: published`：只有正式发布 Release 才触发；
- `id-token: write`：允许 GitHub 签发 OIDC 身份令牌；
- Node 24 + 最新 npm：避免旧 npm 对 Trusted Publishing/provenance 支持不一致；
- `--provenance`：为 npm 包附加可验证的构建来源信息；
- 不需要把 npm token 写进 GitHub Secrets。

### 13.3 一次标准版本发布

先确保本地测试通过、工作区干净：

```sh
node --check index.js
node --check client.js
node selftest.mjs
git status
```

升级版本（三选一）：

```sh
npm version patch   # 1.1.2 -> 1.1.3，修 bug
npm version minor   # 1.1.2 -> 1.2.0，向后兼容的新功能
npm version major   # 2.0.0，不兼容变更
```

推送提交和 tag：

```sh
git push origin main
git push origin --tags
```

然后在 GitHub 创建 Release：

```sh
gh release create v1.1.3 \
  --title "v1.1.3" \
  --notes "本次变更说明"
```

Release 发布后：

1. GitHub Actions 自动运行 `Publish to npm`；
2. 查看 Action 日志确认成功；
3. 执行 `npm view dsh-workspace-memories version` 验证；
4. 确认 npm 页面显示新版本和 provenance 信息。

版本号、`package.json`、git tag、GitHub Release、npm 版本应保持一致。

---

## 14. 用户如何安装发布后的插件

### 从 npm

```sh
dsh plugin --profile desktop add dsh-workspace-memories
```

### 直接从 GitHub

```sh
dsh plugin --profile desktop add github:lengfengng-tech/dsh-workspace-memories
```

因为源码就是可运行的 JavaScript，GitHub 安装不需要构建脚本或额外 build 授权。

### 安装后

- 重载 Host 代码时重启 DSH；
- 如果旧会话看不到工具，等当前轮结束或新开会话；
- 侧栏打开「工作区记忆」；
- 对 Agent 说“记住：……”即可验证写入。

---

## 15. 本次实际踩过的坑与解决办法

| 坑 | 现象 | 根因与解决 |
|---|---|---|
| 只做了文件管理，Agent 仍“记不住” | 面板能编辑文件，但其他会话不知道内容 | 记忆闭环不完整；增加 prompt 自动注入和 `save_workspace_memory` 工具 |
| 主按钮白底白字 | 深色主题下按钮文字消失 | 错把 `brand-primary + #fff` 当主按钮；改用宿主 `button-primary-fill` 与 `label-primary-foreground` |
| Host 改完不生效 | 工具列表仍是旧状态 | 已加载的 Host JS 模块不能靠普通开关替换；重启 DSH |
| 重装后 Client 入口短暂消失 | slot 中暂时找不到插件 | 模块/页面同步存在时序；重新检查 slot，必要时刷新页面或重启，不凭安装日志猜 UI 状态 |
| PTC 会话找不到新工具 | 注册表有，模型声明没有 | 当前轮的工具声明早于注册；下一轮或新会话重新生成 |
| 把功能问题误判为模式限制 | 以为 PTC 不支持该工具 | 全局工具默认对所有预设可见；真正例外是自定义 `tools.restrict` 白名单 |
| 文件名非法字符 | 语法检查报正则范围错误、潜在路径穿越 | 安装前 `node --check`，并统一校验名称、分隔符、`..`、控制字符 |
| 本地目录改名后链接失效 | 原 `link:` 指向旧目录 | 移除旧 bundle，再从新路径安装；不要手工改 profile |
| npm 包名撞名 | 发布会被拒绝 | 发布前 `npm view`；本次由 `dsh-workspace-memory` 改为 `dsh-workspace-memories` |
| 改包名只改一处 | DSH 找不到模块或插件行 | 同步 patch name、client module id、README、安装记录、仓库链接 |
| npm 403，提示需要 2FA | `Two-factor authentication ... required to publish` | `npm profile get` 显示 `two-factor auth: disabled`；开启 2FA 后重新发布并输入 OTP |
| 发布内容不干净 | 自测或临时文件进入 npm | 配置 `files` 白名单，发布前 `npm publish --dry-run` 检查 Tarball Contents |
| CI 环境 npm 行为不一致 | Trusted Publishing/provenance 步骤异常 | 使用 Node 24 和最新 npm，并在 workflow 中打印 `npm --version` 便于定位 |
| 仓库/组织改名后链接陈旧 | npm 页面、git remote 指向旧地址 | 同步 git remote 和 package.json 的 repository/homepage/bugs |

---

## 16. 可复用的最终检查清单

### 写插件

- [ ] 已用 inspect 确认 slot、service、event 的真实契约；
- [ ] `package.json` 同时声明 `dsh.bundle.patch` 和需要的 `dsh.client`；
- [ ] patch 的包名与 client module id 一致；
- [ ] 侧栏 id 与 `main` key 一致；
- [ ] 注册资源都能随插件卸载清理；
- [ ] 文件路径、文件名、内容大小有边界；
- [ ] 样式使用主题 token，不引入重复 React。

### 测试与安装

- [ ] `node --check index.js`；
- [ ] `node --check client.js`；
- [ ] `node selftest.mjs`；
- [ ] 安装结果为 `application: applied`；
- [ ] Host 条目激活；
- [ ] Client slot 有实际占用；
- [ ] 工具列表能看到新工具；
- [ ] 至少做一次真实端到端操作。

### GitHub 与 npm

- [ ] README 说明动机、安装、使用、限制；
- [ ] LICENSE、`.gitignore`、仓库链接、topics 完整；
- [ ] `npm whoami` 成功；
- [ ] `npm view <name>` 检查撞名；
- [ ] `npm publish --dry-run --access public` 检查内容；
- [ ] 已启用 2FA，或正确配置 Trusted Publishing；
- [ ] 发布后用 `npm view <name> version` 验证；
- [ ] package 版本、git tag、GitHub Release、npm 版本一致。

---

## 17. 一句话总结这次经验

**先用运行时检查确定 DSH 的真实扩展点，做出“面板管理 + 自动注入 + Agent 写入”的完整闭环；安装后分别验证 Host、Client 和工具；发布时把包名、模块 ID、仓库地址、2FA/Trusted Publishing 和版本号作为一条链路一起管理。**

---

## 18. 新电脑环境恢复与账号认证（自用）

这一节用于换电脑或重装系统后恢复开发环境。记录的是**账号标识、工具安装、认证方法和密钥管理方式**，不记录任何真实私钥、Token、OTP 或恢复码。

> 重要原则：文档即使只给自己看，也不要写入 `id_ed25519` 私钥内容、`npmrc` 中的 `_authToken`、gh OAuth Token、2FA 动态码或恢复码。新电脑优先“重新生成并授权一套新密钥”，不要把旧私钥复制到聊天或文档里。

### 18.1 当前使用的账号和资源

| 项目 | 当前值 |
|---|---|
| GitHub owner / 组织 | `lengfengng-tech` |
| GitHub 仓库 | `dsh-workspace-memories` |
| 仓库网页 | <https://github.com/lengfengng-tech/dsh-workspace-memories> |
| SSH remote | `git@github.com:lengfengng-tech/dsh-workspace-memories.git` |
| npm 登录账号 | `lengfengng1` |
| npm 包名 | `dsh-workspace-memories` |
| npm registry | `https://registry.npmjs.org/` |
| DSH profile | `desktop` |
| DSH 数据目录 | `~/.dsh/` |
| 默认工作区记忆目录 | `~/.dsh/workspace-memory/` |
| 当前开发目录（本机） | `/Users/hxq/Desktop/test_ai/dsh-workspace-memory` |
| CI 发布工作流 | `.github/workflows/publish.yml` |

如果以后账号、组织或目录改名，要同步修改这一节、`package.json` 的仓库链接和 git remote。

### 18.2 新电脑必装工具

macOS 建议先安装 Xcode Command Line Tools 和 Homebrew：

```sh
xcode-select --install

/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

然后安装开发和发布工具：

```sh
brew install git gh node pnpm
```

各工具用途：

| 工具 | 用途 | 是否必须 |
|---|---|---|
| `git` | 克隆、提交、tag、推送 | 必须 |
| `node` / `npm` | 语法检查、自测、npm 发布 | 必须 |
| `gh` | GitHub 官方 CLI：认证、建库、Release、查看 Actions | 强烈推荐 |
| `pnpm` | DSH 插件包管理、部分插件开发流程 | 建议安装；本插件纯 JS 自测不依赖它 |
| DeepSeek Harness Desktop | 安装插件、验证侧栏和 Agent 功能 | 必须用于运行验证 |

检查版本：

```sh
git --version
node --version
npm --version
pnpm --version
gh --version
```

本地开发使用当前 Node LTS 即可；仓库发布工作流固定使用 **Node 24 + 最新 npm**，避免 Trusted Publishing/provenance 的兼容性问题。

### 18.3 配置 Git 身份

```sh
git config --global user.name "lengfengng-tech"
git config --global user.email "<使用 GitHub Settings → Emails 中提供的 noreply 邮箱>"
```

不要直接在公开提交里使用不想公开的真实邮箱。GitHub 的 noreply 地址可在网页设置中查看。

### 18.4 登录 GitHub CLI（gh）

`gh` 是 GitHub 官方命令行工具，用来完成认证、建仓库、发 Release、查看 CI：

```sh
gh auth login
```

推荐选择：

1. `GitHub.com`；
2. Git 协议选 `SSH`（与当前仓库 remote 一致）；
3. 用浏览器登录并完成授权；
4. 按提示允许 gh 管理 GitHub 认证。

验证：

```sh
gh auth status
```

应看到正确的 GitHub 账号和 `repo` 等权限。gh 的 OAuth Token 由系统钥匙串管理，**不要从钥匙串导出到文档**。

如果改用 HTTPS remote，可以再执行：

```sh
gh auth setup-git
```

当前仓库使用 SSH，因此不需要这一步。

### 18.5 新电脑生成 GitHub SSH 密钥

当前仓库地址是 SSH 形式，所以需要给新电脑配置 SSH key。**推荐每台电脑单独生成一把 key**，不要从旧电脑复制私钥。

```sh
ssh-keygen -t ed25519 -C "lengfengng-tech GitHub"
# 默认路径 ~/.ssh/id_ed25519；可设置一个自己记得住的 passphrase

eval "$(ssh-agent -s)"
ssh-add --apple-use-keychain ~/.ssh/id_ed25519
```

把**公钥**添加到 GitHub（公钥可以分享，私钥不行）：

```sh
gh ssh-key add ~/.ssh/id_ed25519.pub --title "新电脑-$(date +%F)"
```

也可以在 GitHub 网页手动添加：

```text
Settings → SSH and GPG keys → New SSH key → Authentication Key
```

测试：

```sh
ssh -T git@github.com
```

看到 `Hi <account>! You've successfully authenticated...` 即成功。

本机排障命令：

```sh
ssh-add -l                 # 查看 agent 中已有 key 的指纹，不显示私钥
ls -la ~/.ssh             # 只查看文件名和权限，不要 cat 私钥
```

私钥文件权限应保持：

```sh
chmod 700 ~/.ssh
chmod 600 ~/.ssh/id_ed25519
chmod 644 ~/.ssh/id_ed25519.pub
```

如果旧电脑淘汰，记得在 GitHub 的 SSH keys 列表中删除旧电脑对应的公钥。

### 18.6 克隆仓库并恢复开发环境

```sh
mkdir -p ~/Desktop/test_ai
cd ~/Desktop/test_ai
git clone git@github.com:lengfengng-tech/dsh-workspace-memories.git
cd dsh-workspace-memories
```

如果换电脑后目录不同，不需要修改插件代码；本地开发安装时使用新的绝对路径即可。

运行检查：

```sh
node --check index.js
node --check client.js
node selftest.mjs
```

在 DSH 中按本地目录安装：

```sh
dsh plugin --profile desktop add "$PWD"
```

也可以让 Agent 调用 `plugin_manager install_bundle`，`target` 使用新电脑上仓库的绝对路径。

修改 `index.js` 后重启 DSH；修改 `client.js` 通常可由 Client HMR 热更新。

### 18.7 登录 npm 并恢复 2FA

在新电脑登录 npm：

```sh
npm login
npm whoami
npm profile get
```

预期：

- `npm whoami` 返回 `lengfengng1`；
- `npm profile get` 显示邮箱已验证、2FA 已启用。

如果还没有 2FA：

1. 打开 <https://www.npmjs.com> 并登录；
2. 进入 Account → Two-Factor Authentication；
3. 用验证器 App（如 1Password、Microsoft Authenticator、Google Authenticator）扫码；
4. 开启写操作所需的 2FA；
5. 将恢复码放进密码管理器或离线安全位置，**不要写进本文档**。

手动发布时：

```sh
npm publish --dry-run --access public
npm publish --access public
```

第二条会要求输入验证器里的 6 位动态码。动态码只有几十秒有效，现场输入，不要预先记录。

npm 登录状态通常保存在 `~/.npmrc`。该文件可能含有：

```text
//registry.npmjs.org/:_authToken=...
```

**不要把 `~/.npmrc` 内容贴到 issue、聊天或本文档中。** 检查登录状态用 `npm whoami`，不需要查看 Token。

### 18.8 Token、私钥和恢复码应该如何保存

| 密钥/认证材料 | 推荐保存方式 | 新电脑如何处理 | 绝不能做什么 |
|---|---|---|---|
| GitHub SSH 私钥 `~/.ssh/id_ed25519` | 本机 `~/.ssh` + 系统文件权限 + 可选 passphrase | 每台电脑重新生成，再把新公钥加到 GitHub | 不要复制进文档、git 或聊天记录 |
| gh OAuth Token | gh 管理，保存在 macOS Keychain | `gh auth login` 重新授权 | 不要从钥匙串导出保存 |
| npm 登录 Token | npm CLI 写入 `~/.npmrc` | `npm login` 重新登录 | 不要打印或提交 `.npmrc` |
| npm 2FA 动态码 | 验证器 App 实时生成 | 在新手机的验证器中恢复 npm 2FA | 不要提前记录到文档 |
| npm 2FA 恢复码 | 密码管理器或离线安全位置 | 丢失验证器时用于恢复账号 | 不要明文放进仓库 |
| npm granular access token | 仅在确有需要时创建，最小权限、最短有效期 | 一般不用于当前 CI；若必须使用则放 GitHub Secret | 不要开启不必要的 bypass 2FA，不要硬编码 |
| DSH/模型服务凭据 | DSH 自己的凭据管理功能 | 在新电脑的 DSH 中重新配置 | 不要写进工作区记忆文件 |

当前仓库使用 **Trusted Publishing + OIDC**，CI 不需要 `NPM_TOKEN`，因此不需要为发布流程创建长期 npm granular token。

### 18.9 当前 CI 的 Trusted Publishing 绑定信息

如果换账号、换仓库或需要重建 npm 包，在 npm 包的 Trusted Publisher 设置中重新绑定：

| 配置项 | 当前值 |
|---|---|
| 平台 | GitHub Actions |
| Owner | `lengfengng-tech` |
| Repository | `dsh-workspace-memories` |
| Workflow | `.github/workflows/publish.yml`（若表单只要求文件名，填 `publish.yml`） |
| Release 触发 | GitHub Release `published` |
| npm Token | 不需要，使用 OIDC |
| Provenance | `npm publish --access public --provenance` |

不要把 Trusted Publishing 和 `NPM_TOKEN` 混用：当前 workflow 走的是 OIDC，不读取 npm 长期 Token。

### 18.10 如果怀疑密钥或 Token 泄露

按优先级立即处理：

1. **GitHub SSH key 泄露**：在 GitHub Settings → SSH and GPG keys 删除对应公钥；新电脑重新生成一把；
2. **gh Token 泄露**：`gh auth logout`，在 GitHub 中撤销相关授权，然后重新 `gh auth login`；
3. **npm Token 泄露**：在 npm Access Tokens 页面撤销，或使用 `npm token list` 找到后执行 `npm token revoke <token-id>`；
4. **npm 2FA 设备丢失**：使用离线保存的恢复码登录，再重新绑定验证器；
5. **已经误提交到 git**：仅删除文件不够，还要撤销密钥，并清理 git 历史；公开仓库应按“已经泄露”处理。

### 18.11 新电脑恢复完成后的快速自检

```sh
# 工具
node --version && npm --version && gh --version && git --version

# GitHub 与 SSH
gh auth status
ssh -T git@github.com
git remote -v

# 插件代码
node --check index.js
node --check client.js
node selftest.mjs

# npm
npm whoami
npm profile get
npm view dsh-workspace-memories version

# GitHub Release / CI
gh workflow view "Publish to npm"
gh run list --workflow "Publish to npm" --limit 5
```

全部通过后，就可以在新电脑继续开发、提交、打 tag、发 GitHub Release，并由 CI 自动发布 npm。

