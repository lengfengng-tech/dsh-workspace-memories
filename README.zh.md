# dsh-workspace-memories（工作区记忆）

[English](README.md) | 中文

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
[![](https://img.shields.io/npm/v/dsh-workspace-memories?style=flat-square)](https://www.npmjs.com/package/dsh-workspace-memories)
[![](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）增加**工作区级持久记忆**：每个工作区拥有独立的记忆文件，默认存放在项目之外的 DSH 数据目录，自动注入该工作区每个会话的上下文，并可由 Agent 主动写入。

## 为什么做这个插件

DSH 的 Agent 跨会话是无状态的：一个会话"学到"的东西——项目决策、约定、排障结论——只存在于当次对话的上下文里，会话结束就丢了。内置的持久知识机制是 `AGENTS.md`，但它是静态的、项目拥有的指令文件：Agent 不能自己更新它，而且**有些东西本来就不该放进项目文件夹**——服务器地址与拓扑、本机环境差异、机器相关的路径、个人工作习惯。放在项目目录里的任何东西都有被误提交进 git 的风险。

本插件用一个简单透明、且**默认存在项目目录之外**的记忆闭环补上这个缺口：

1. **每个工作区一个记忆目录**——默认在 DSH 数据目录下（`~/.dsh/workspace-memory/<工作区>/`），不进仓库；纯 Markdown，可读、可 diff、可备份。（另提供 `workspace` 存储模式，把记忆放在 `<工作区>/.dsh/memory/`，适合想随代码一起版本化的团队共享记忆。）
2. **记忆自动注入**——在该工作区创建的每个会话，系统提示都会携带这些记忆文件（与 `AGENTS.md` 并存），新会话一开始就"记得"。
3. **Agent 可以自己记**——全局工具 `save_workspace_memory` 让任意会话在你说"记住这个"的当下就把决策、服务器细节、约定、偏好落成文件。
4. **你始终可控**——侧栏面板按工作区列出、新建、编辑、删除记忆文件，记忆摊在阳光下，而不是藏进数据库。

## 功能

| 能力 | 入口 |
|---|---|
| 浏览 / 新建 / 编辑 / 删除记忆文件 | 侧栏「工作区记忆」面板（可切换工作区） |
| 让 Agent 记住事情 | 任意会话直接说「记住：…」→ Agent 调用 `save_workspace_memory` |
| 记忆自动生效 | 该工作区每个会话的系统提示自动携带其记忆文件 |

所有内置 Agent 预设（标准、PTC、极简、创造）均可用：工具注册在根组合，全局工具默认对所有预设可见。唯一例外是自定义预设使用 `tools.restrict` 白名单（`allow: [...]`）的情况——把 `save_workspace_memory` 加进白名单即可。

## 安装

本包为纯 JavaScript、无构建步骤，所有安装渠道都可用：

```sh
# 从 npm 安装（发布后）
dsh plugin --profile desktop add dsh-workspace-memories

# 直接从 GitHub 安装（无需构建脚本，源码即产物）
dsh plugin --profile desktop add github:lengfengng-tech/dsh-workspace-memories

# 从本地目录安装
dsh plugin --profile desktop add ./dsh-workspace-memories
```

或用 GUI：侧栏「插件 → 添加插件」，粘贴包名、GitHub 地址或本地绝对路径，装完点「立即启用」。

卸载：插件页操作，或 `dsh plugin --profile desktop remove dsh-workspace-memories`。

## 使用

- 打开侧栏「工作区记忆」，默认选中当前会话所属工作区；「新建文件」创建 `.md` 记忆（扩展名自动补齐），选中文件即可编辑、保存、删除。
- 对 Agent 说「记住：项目用 pnpm 不用 npm」，它会写入记忆文件，该工作区的**所有会话**（以及面板）立即可见。
- 存储方式可配置：`storage: home`（默认，DSH 数据目录，项目之外）或 `storage: workspace`（项目内 `directory` 指定的目录，默认 `.dsh/memory`）。

## 重要：安装或升级插件后请新开会话

工具注册在宿主端即时生效，但**模型"看到"的工具清单是每轮对话开始时组装的**：

- 如果某个会话的当前轮次在插件安装/重载**之前**就开始了，它本轮拿到的工具声明是旧的。PTC 模式下尤其明显：模型读到的是预生成的 TypeScript 绑定（`ToolArgsMap`），里面还没有 `save_workspace_memory`，于是可能误判"没有记忆工具"，甚至绕路"探测式"硬调（其实也能调通，因为真正分发走的是宿主注册表）。
- **解决办法很简单：新开一个会话，或等当前轮结束后直接发新消息。** 新一轮会重新生成工具声明，`save_workspace_memory` 就会正常出现，无需任何探测。

系统提示中的记忆注入在 Agent 创建时挂载（会话新建 / 重启恢复 / 清空 / 压缩时触发）；已挂载的会话会在记忆文件变化后的下一步自动看到新内容。

## 目录与安全

两种存储模式，由插件配置项 `storage` 选择：

| 模式 | 记忆位置 | 适合 |
|---|---|---|
| `home`（默认） | `~/.dsh/workspace-memory/<工作区目录>/`——项目之外 | 本机或敏感信息：服务器配置、环境差异、个人约定 |
| `workspace` | `<工作区>/.dsh/memory/`——项目之内 | 想随代码一起提交的团队共享记忆 |

```
~/.dsh/workspace-memory/    # 默认记忆库，每个工作区一个子目录
dsh-workspace-memories/       # 本插件
├── package.json          #   bundle 清单（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml      #   插件行声明
├── index.js              #   宿主：/api 路由 + 记忆注入 + 写记忆工具
├── client.js             #   浏览器：侧栏入口 + 管理面板
├── locale/               #   面板文案（中/英）
├── icon.svg
└── selftest.mjs          #   宿主逻辑自测：node selftest.mjs
```

安全约束：浏览器面板只能按 `workspaceId` 操作已注册工作区（无法触达任意宿主路径）；文件名严格校验（拒绝路径分隔符、`..`、空白与控制字符）；单文件上限 1 MiB；注入提示时单文件截取前 32K 字符、最多 20 个文件。

## 开发与调试

- 以 `link:` 方式安装时（本地路径安装即是）：改 `client.js`（界面）经客户端 HMR 即时生效；改 `index.js`（宿主）需重启 DSH 加载新模块。
- 自测：`node selftest.mjs`（模拟插件上下文，覆盖路由、注入渲染、工具写入与校验失败）。
- 运行时检查：宿主条目 `include:workspace-memory` 应为 `active`；客户端 slot `sidebar.panellist` 应有 `workspace-memory` 占用项；`save_workspace_memory` 应出现在工具列表中。

## 许可证

[MIT](LICENSE) — © 2026 lengfengng-tech

---

本插件是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建的社区插件，并非 DeepSeek 官方产品。命名遵循 [DSH 品牌指南](https://github.com/deepseek-ai/deepseek-harness/blob/main/BRAND_GUIDELINES.zh.md)。
