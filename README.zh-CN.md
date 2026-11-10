# dsh-superagent-further

[English](README.md) | [简体中文](README.zh-CN.md)

[![check](https://github.com/louifinn/dsh-superagent-further/actions/workflows/check.yml/badge.svg)](https://github.com/louifinn/dsh-superagent-further/actions/workflows/check.yml)
[![smoke](https://github.com/louifinn/dsh-superagent-further/actions/workflows/smoke.yml/badge.svg)](https://github.com/louifinn/dsh-superagent-further/actions/workflows/smoke.yml)

> **这是 fork，不是 DeepSeek 官方产品。** 它基于
> [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 构建，后者是
> 随《Exploring Super-agent Design: Towards a More Autonomous Agent System》一文发布的研究原型。原型是研究代码：
> 单仓库、单主机、仅支持 POSIX 部署、没有 CI。本 fork（`louifinn/dsh-superagent-further`）保留其设计，把它变成
> 团队每天可用的软件：多项目、项目级编排层、Windows 原生、可安装的发布版本，以及三平台都会运行的检查。它仍然是
> 需要人来运维的工具，而不是托管服务：在让它无人值守运行之前，请先读
> [设计哲学](docs/000-philosophy.md) 与 [部署指南](docs/006-deployment.md)。

dsh-superagent-further 是面向团队所用仓库的主动式编程智能体，以插件包（bundle）的形式运行在
[DeepSeek Harness](https://www.deepseek.com/en/harness/) 上。它监听 GitHub，也可选用飞书。当团队允许的人向它
发出工作请求时，它会开出一个请求（Request）以及交付该请求的若干工单（Ticket），让每张工单在自己的会话和检出目录里
工作，并在原来的对话里回复 —— 通常是一个由人合并的 pull request。Web 面板只列出等待人处理的事项。

它由一条原则驱动：**尽可能少占用人的注意力，尽可能多地交付价值。** 每条消息、每个设置、每行面板、每段文档都必须
挣得其消耗的注意力。这条原则与原型一致；本 fork 把它延伸到了项目层、运维与分发（见
[本 fork 相对原型的设计差异](#本-fork-相对原型的设计差异) 与 [产品理念的进一步完善](#产品理念的进一步完善)）。

## 状态一览

| | |
| --- | --- |
| 运行平台 | Windows 10/11 原生（桌面应用或 `scripts\dsh-superagent-further.cmd`）、Linux（WSL 验证 + CI）、macOS（CI + smoke 主机） |
| 依赖 | Node.js `^22.19.0 || >=24`、pnpm `11.7.0`、git 2.32+、DeepSeek Harness `0.2.2-rc.1`（版本固定在 [006](docs/006-deployment.md)）；不需要 Python，不需要 tmux |
| 检查 | `pnpm check`：87 个 spec 文件，**1497 passed / 5 skipped（1502）**，包含类型检查与构建；每次推送在六种平台/Node 组合上运行 check.yml 且全绿 |
| 发布 | `0.3.0`（[CHANGELOG](CHANGELOG.md)）；推送 `v*` 标签会运行检查、打包 `dsh-superagent-further-0.3.0.tgz` 并发布 |
| 真实验证 | 真实 GitHub 与飞书请求以人为合并的 pull request 结束；一个项目 Lead 作为隐藏子会话执行了真实工单；一个跨项目 Request 产出两张工单、两个 PR，并以一个 `done` 结果收尾 |
| 项目请求 | worker 在工单需要决定、新交付物或其他项目的工作时提出持久的 `project_request`；项目 Lead 必须回复并处置，接受的工作请求会在限定于该项目内创建 Request 与分阶段 Ticket，架构请求等待人记录在案的批准，独立的 DSH 会话可以提交工作并总会收到答复；项目自动化投递可经其 Lead 提出一个项目请求，安装级自动化投递可由主会话创建安装级 Request，Lead 可把本项目之外的工作升级给 Orchestrator 决定 |
| 状态数据库 | 架构版本 22（`10 → 11 → … → 21 → 22` 原地迁移；`scripts/verify-install` 以只读方式报告架构版本） |

## 它做什么

1. **监听。** 来源（Source）读取 GitHub（Issue 与 PR 对话、评审、提及、CI 结果），以及可选的飞书（已登记群里的
   `@DSH` 提及、私聊、历史回填，以及每日摘要）。每个来源都会报告自己的状态、下次尝试时间与最近一次失败。
2. **判断。** 只有当事件直接指向智能体、且来自团队允许的人时，它才会成为触发（Trigger）。主会话把触发当作**数据**
   评估，而不是当作指令；接受工作必须有明确的请求，或团队配置过的书面规则。
3. **接受。** 被接受的工作成为一个 **Request**（人的请求）以及一张或多张 **Ticket**（按交付单元、按项目划分）。
   Request 承载确认与最终结果；每张工单承载自己的交付契约、Lead 与执行器，变更类工单还承载检出目录与 pull
   request。没有已登记项目能承接的工单会在接受阶段被拒绝，并提示去 **Execution → Projects** 登记项目。
4. **执行。** `change` 工单从所属项目的本地 clone 获得一个工作树；`answer` 工单只读该 live clone。两者都作为
   该项目 **Lead** 会话的隐藏子智能体运行。输入、状态请求与报告都经由 Lead 传递；人也可以直接和 Lead 对话。
5. **交付。** `change` 工单由执行器开出 pull request 并报告，人评审并合并后，来源观察到合并，工单以 `merged` 结束，
   Request 只报告一次结果；`answer` 工单的 ready 报告就是交付物，并以 `completed` 结束。失败始终可见：健康状态、
   回复队列、发件箱与日志都会说明卡在哪里，以及运维者接下来能做什么。

## 快速开始

安装步骤较多，所以由智能体与你一起完成。对你的编程智能体说：

> 阅读本仓库的 SETUP.md，和我一起配置 dsh-superagent-further。

它会一次问一个简短问题，展示一次完整计划，然后安装并配置好一切。手工参考手册 —— 账号、项目、执行、来源、托管、
升级与故障排查 —— 是 [docs/006-deployment.md](docs/006-deployment.md)。简要步骤如下：

1. 安装 DeepSeek Harness `0.2.2-rc.1`，并把这个插件包装进一个配置档（profile）。可以从 checkout 安装，也可以从
   发布 tarball 安装：`dsh plugin --profile superagent add "link:<checkout>"` 或
   `dsh plugin --profile superagent add "file:<tarball>"`。
2. 在配置档的 `cordis.patch.yml` 里写入本机回环（loopback）`webserver` 端口、`stateDir`，以及使用飞书时的飞书插件。
3. 在面板里登记 **Projects**：id、本地 clone 的绝对路径、`owner/name` 形式的仓库、可选基线分支。启动前必须至少
   有一个项目；没有项目时 onboarding 会拒绝启动。
4. 启动主机（Windows 用 `scripts\dsh-superagent-further.cmd start`，其他平台用 `scripts/dsh-superagent-further start`），
   从日志里拿到面板 URL，用 token 登录。
5. 运行 `scripts/verify-install`（Windows 上为 `.cmd`）：它会检查 DSH 版本、配置档、patch、API、持有状态锁的进程
   以及数据库架构，只有安装就绪时才以 `0` 退出。
6. 按 006 的说明用 CLI 包装脚本配置 **GitHub** 与 **飞书** 来源，把允许的账号加入 **Policy**，然后发一条测试消息。

## 项目层

原型只有一个主会话，为每张工单启动一个根级（root）worker 会话。项目一多，会话列表就会随工作量增长，项目级的劳动也会
留在总编排器身上。本 fork 增加了一层：

```text
Orchestrator（主会话，`orchestrator-<hash>`）
└── 每个项目的 Lead（常驻会话，`lead-<projectId>`）              在会话列表中可见
    └── 作为隐藏子智能体的执行器（持久 DSH 会话，`worker-<ticketId>`）
```

- **Orchestrator** 掌握来源、评估、准入、Policy 与跨项目优先级。它创建跨项目 Request 与 Ticket，并把工单派发给
  Lead；项目 Lead 处置自己项目的项目请求，永远不接跨项目工作。
- **Lead** 拥有一个项目：项目的上下文、它的会话，以及作为其子会话运行执行器。它把项目的 clone、仓库与基线分支放进
  自己的提示词，接收每一张派来的工单，并暴露 `lead_status` 与项目请求工具。它必须回复 worker 提出的请求，只有接受
  这些请求才会创建本项目的 Ticket，让架构工作经过人的批准，并且永远不能修改 Policy 或设置。人可以从面板打开它并
  直接对话；那是这个项目最高优先级的人类输入。
- 执行器是其 Lead 的子智能体。它们保留自己的会话、检出与 worker 预设，但不会出现在普通会话列表里；Lead 是它们的
  父会话，报告经由它落定，输入也经由它送达，而不是去 prompt 一个由 Lead 拥有的会话。重启后会恢复会话，子会话会被
  接管（adopt），否则工单会被重新派发。

通信使用持久化的 sqlite 记录，effects 只负责投递。没有第二条消息总线，也没有共享任务板，因为 Engine 是领域状态的
唯一写入者。两个主机不能共用一个状态目录：桌面应用内的实例与服务脚本会互相拒绝，并给出的消息会指出锁的持有者以及
切换所需的那一条命令。在日常桌面应用内，worker 环境是进程级应用的 —— 因为这会改变该应用中每个会话的 `PATH` 与
`GIT_CONFIG_GLOBAL`，006 对此有明确说明。

## 项目与跨项目请求

**Project** 是一条记录 —— `{id, name, workspace, repository, branch}` —— 存放在执行（Execution）设置里。添加一个
项目会带来三件事：GitHub 来源开始轮询它的仓库（非部署仓库的 Thread id 会带上 `owner/name#<number>` 限定，因此不同
仓库不会冲突）、该项目的工单在 `<stateDir>/work/<project>/` 下获得自己的工作树、面板/摘要/Lead 行都能指出它。
智能体读不到的仓库会报告在来源健康状态里，而不是让整轮轮询失败。

跨项目请求仍然是**对一个人的一个承诺**。它的接受结果可以列出多个交付单元；Orchestrator 创建一个 Request，并为每个
单元创建一张 Ticket（各自属于一个项目），Ticket 之间可以有简单的 `after` 依赖边。没有未满足依赖的工单立即开始；
串行与并行交付都由这些边自然导出。Request 只产生一次确认、一个列出所有 pull request 的最终结果，以及单一的
`done` / `partial` / `stopped` 状态；每日摘要会列出进行中的 Request。一张工单仍然只配一个执行器：跨项目的并行由
多张工单表达，而不是在一张工单里放多个执行器。该方向已于 2026-11-08 定案，后续“分段 fan-out”的分析保留在
[010](docs/010-project-orchestrator.md) 中，作为未来选项，而不是待办事项。

## 本 fork 相对原型的设计差异

原型是为单仓库、单 POSIX 主机、单人运维者准备的忠实研究产物。本 fork 保留其领域模型与哲学，改变的是日常使用提出的
要求：平台、多项目、执行层级、运维、证据与分发。相对原型唯一提交（`8c32a9d`）的差异是当前 HEAD 上的
**223 个文件、+20,995 / −1,589**（这条线上第一个发布是 `0.2.0`），而本地历史从逐字节一致的导入开始，所以下面每一处
改动都来自本 fork。

| 方面 | 原型 | 本 fork | 原因 |
| --- | --- | --- | --- |
| 平台 | macOS/Linux，POSIX shell 脚本，依赖 Python、`tmux`、`fcntl`、`ps` | Windows 原生的 Node 服务脚本；Windows 批处理/CLI 处理、`pwsh` shell、`icacls` 状态 ACL；保留 Linux 与 macOS | 运维者的日常机器是 Windows；多一套依赖就是工具没有挣到的注意力 |
| 规模 | 单仓库、单主机、单状态目录 | 一个来源轮询多个项目、按项目检出与 Lead、按项目的并发限制；强制一主机 | 团队在多个仓库工作；第二个配置档或第二个智能体会增加概念与噪音 |
| 执行 | 每张工单一个根 worker 会话 | Orchestrator → 每项目常驻 Lead → 隐藏执行器子智能体，重启后接管 | 会话列表更干净、项目上下文常驻，总编排器不再承担项目劳动 |
| 跨项目 | 一次接受的请求 = 一张工单、一个目录 | Ticket 之上的 Request，每交付单元一张工单、`after` 依赖、一次确认/一次结果/一个 done | 单张工单无法合法跨越项目；而人发的仍是一个请求 |
| 交付契约 | 工单隐含就是一次交付：标 ready 就以 completed 结束，无论是否开过 PR | 每张工单带 `deliverable: change` 或 `answer`；`change` 获得分支与工作树，只能经被关注的 PR 结束（ready 报告须给出 PR），`answer` 只读项目的 live clone、以 `completed` 结束 | 只读问答不该为永不能合并的分支付费；没开 PR 的变更不能报成功 |
| Agent 自举工作 | 工作只能来自经人工 Policy 接受的来源事件 | worker、项目 Lead、安装级自动化与独立 DSH 会话都能以持久请求发起工作；每条路径都记录来源、必须回复，且不能绕过 Policy 或准入 | 智能体必须能开始它发现的工作，但不能把自己的报告当作授权 |
| 状态 | 只认精确架构版本，没有向前迁移 | 逐步迁移 `10 → 11 → … → 22`、只读架构检查、升级与回滚步骤 | 要长期运行，状态就必须能跨升级存活 |
| 运维 | 通过 POSIX `ps`/`tmux` 启停，没有自检 | Node 服务脚本（CIM 发现）、优雅的 `POST /orchestrator/api/shutdown`、`verify-install`、`switch-project`、工作树回收与 `clean-worktrees`、有界日志 | 无人值守需要每个平台上可见、可脚本化的运维 |
| 可观测性 | 每个组件一个健康词 | 轮询来源的 `nextAt`、连续失败计数、带最久等待与下次尝试的回复队列、等待中工单的动作与时长、Request 行、群日报 | “每个失败都可见”意味着运维者能看见趋势，而不只是状态 |
| 信任 | 触发的字段信任问题仍列为未决问题 | 可信与不可信字段形成文档并由 `tests/trust.spec.ts` 钉住；消息正文不能改变角色、工具、Policy 或强度；属主独占的状态 ACL；批处理参数防护 | 一旦有第二个人或第二个项目，提示注入与共享机器数据就是真实问题 |
| 工程 | 没有 CI、没有发布、没有 changelog；测试假定 POSIX | `check.yml`（3 个 OS × Node 22/24）、`smoke.yml`（真实 macOS 主机）、`release.yml`（打标签的 tarball）、`.gitattributes`、semver/CHANGELOG、可复现的 `verify-install` | 平台回归与无法验证的安装正是日常工具不能承受的失败 |
| 文档 | 只有编号设计文档（000–008） | 增加 [009 路线图](docs/009-roadmap.md)、[010 项目级编排器](docs/010-project-orchestrator.md)、[011 能力](docs/011-capabilities.md)、[012 项目请求](docs/012-project-requests.md)、本 README、`AGENTS.md`，以及 [docs/agents](docs/agents/domain.md) 下的工程技能脚手架 | 本 fork 的决策与理由必须能脱离产生它的访谈被读懂 |

### 平台与部署

每一个 POSIX 假设都被替换为显式、经过测试的平台路径，而不是兼容层：

- **路径** —— 一条平台规则（`src/infra/paths.ts`）供给各个 schema；`stateDir` 与项目工作区在两个平台族上都是绝对
  路径，原先假定 `/` 的测试现在会运行使用真实 `C:\` 路径的 Windows 分支。
- **服务脚本** —— `scripts/dsh-superagent-further` 是不依赖第三方库的 Node 程序，带 `.cmd` 启动器。Windows 上通过
  `Get-CimInstance Win32_Process` 发现主机（POSIX 回退到 `ps`），把它以分离进程启动、输出写入日志，并通过 shutdown
  路由停止，必要时回退到 `taskkill` 进程树。它不再需要 Python、tmux 或 `fcntl`；它用独占文件锁与失效 PID 接管来加锁。
- **批处理 CLI** —— Windows 上 `spawn`/`execFile` 无法用参数数组启动 `gh.cmd`、`lark-cli.cmd` 以及包装用的
  `.cmd` 文件。统一的调用模块（`src/infra/batch.ts`）用 `cmd.exe /d /s /c` 与 `windowsVerbatimArguments` 构造
  命令行，拒绝“命名了子进程环境中变量”的参数或包含换行的参数，并把多行正文通过 stdin 而不是命令行传递。
- **Worker 环境** —— POSIX 的无扩展名 `#!/bin/sh` shim 变成 `<name>.cmd` shim，会从 `PATH` 中去掉 shim 目录，
  凭据 helper 的比较会处理 realpath 与大小写。`git -c -z --show-origin` 的解析终结了“git 版本过旧”的误报。
- **Shell 工具** —— 主会话在 Windows 上使用 `pwsh`，其他平台使用 `bash`；执行器的 prepare 命令也一样。新增
  `POST /orchestrator/api/shutdown` 路由，是因为 Windows 无法向分离进程投递优雅信号。
- **状态权限** —— POSIX 仍保持 0700/0600；Windows 上用 `icacls` 去掉继承 ACL 并只授予运维者账号。
- **验证** —— Linux 在 WSL 与 CI 上验证，macOS 在 CI 与真实 `smoke.yml` 主机上验证，Windows 在本地与 CI 上验证
  （包括只在 Windows 运行的批处理/ACL 测试）。`scripts/verify-install` 在两种主机模式下检查安装，并按
  就绪 / 故障 / 等待配置分别以 `0/1/2` 退出。

### 项目模型与来源

原型的 GitHub 来源只面向一个 `repository` 和一个 worker 目录。本 fork 把项目变成管理面上的第一等记录，并据此派生
来源的工作。一轮轮询只读一次通知并过滤到被监视的集合，然后读取每个项目仓库的流与默认分支 CI，再读取打开工单的 PR
与已订阅的 Thread。Thread 身份对部署仓库保留原型的数字形式，对其他仓库做限定，因此已存的 Thread 与 Ticket 不需要
改名。智能体读不到的项目仓库会被容忍并报告，而不是让整轮失败。面板的来源卡片会列出所有被监视的仓库，并在项目变化时
更新 —— 这是运维者打开项目层时报告的第二个缺陷。

### 项目 Lead

Lead 是本 fork 主要的架构新增，而且它刻意是一个**层**，不是一个新领域概念：领域里仍然只有来源、Thread、触发、工单、
派发、报告与待答。Lead 是绑定到某个项目的持久会话，带有 (1) 自己的提示词段落，承载项目的 clone、仓库与基线分支，
(2) 用来够到并给子执行器发消息的预设工具 —— 执行器的输入经由它送达，而不是去 prompt 一个它拥有的会话 ——
(3) `lead_status` 与项目请求工具（`lead_requests`、`lead_request_create`、`lead_request_decide`、
`lead_request_reply`、`lead_request_complete`、`lead_request_approval`、`lead_request_approve`、
`lead_request_escalate`），(4) 记录在 `lead_message`（架构 13）
里的派发记录，以及 (5) 没有任何修改 Policy 或设置的途径。被接受的工作作为派发的工单到达它；执行器是它的隐藏子会话。
当工单需要决定、新交付物或其他项目的工作时，worker 会提出项目请求，Lead 必须回复。面板为每个项目显示一行（Lead
会话、运行中的执行器、等待中的消息），有人点击时打开 Lead。Lead 承载的输入与报告路由是 P3 的工作；移除根 worker
路径是 P4，已于 2026-11-08 完成，因此 onboarding 现在要求项目，并且只有一条执行路径。项目请求与批准流程见
[011](docs/011-capabilities.md) 的 Part E，规格在 [012](docs/012-project-requests.md)。

### Ticket 之上的 Request

原型里的 Ticket 是“被授权的工作、一次交付”的单位，这一点保持不变。Request 是可能包含多次交付的、被接受的人类请求：
它持有工单 id、唯一一次确认与唯一一个最终结果。Orchestrator 创建跨项目 Ticket；Lead 只有在接受其 worker 的项目
请求时才创建本项目的 Ticket，而且每张这样的工单都限定在该项目内。依赖是简单的 `after` 边，而不是工作流引擎，
因为哲学不会为“一个属性加一段提示词就能表达的业务需求”新增概念。真实验证：一个 GitHub 请求创建了 Request
`90df28d6…`，在 `louifinn/project-check` 与 `louifinn/Napkid-Derivate` 里各有一张工单；PR #18 与 PR #12 在
`00:09Z` 合并，Request 在 `00:10:25Z` 以 `done` 结束，并且只报告一次两个 pull request。

项目请求是 worker 向上的路径。它是一条持久记录，不是 Ticket 也不是触发，因此不经过准入与 Policy；接受它会用
`lead` 依据的 Mandate 创建一个普通 Request 及其分阶段 Ticket，强度为 explicit，边界是本项目。拒绝或要求补充信息时
只记录回复，其他什么都不改。未答复的请求会被提醒两次，然后记录为需要关注；Lead 用一条汇总报告结束根请求，发到
整条链开始的渠道。架构请求多一步：设计 Ticket 产出方案，人在根 Thread 上批准，之后才会存在实现 Request。独立的
DSH 会话也可以通过 `session` 来源提交工作，并且总会收到答复。自动化投递延伸了同一条上行路径：主会话可把安装级
自动化投递转为安装级 Request（`orchestrator_request_create`），项目 Lead 可把本项目之外的工作升级给 Orchestrator
决定（`lead_request_escalate` → `orchestrator_escalations` → `orchestrator_escalation_decide`），回复回到 Lead，
接受后才以 `escalation` 依据创建安装级 Request。

### 运维、状态与恢复

- **迁移** —— 架构 11–22 重塑记录、填入工单项目、加入 Lead 消息、加入 Request，并结束那些已有工单全部结束的 Request，
  加入跨会话记忆表、移除已退休的 GitHub `repository` 设置，加入设置提案、自动化、自动化投递与项目请求表，并为每张
  工单写入交付契约（未结束的工单与已有被关注 PR 的已结束工单为 `change`，其余为 `answer`）。每一步
  都在打开数据库的事务里执行；`OLDEST_SCHEMA` 与 `verify-install` 让过旧或过新的数据库变得可见，而不是神秘。
- **单主机** —— 状态锁的错误消息会指出另一个主机、它的状态目录与切换命令；被某个存活的 DeepSeek Harness 进程持有的
  orchestrator 会话会被解释清楚，而不是无限重试。应用内主机会进程级地应用 worker 环境，006 平实地写明这一点，因为它
  改变了该应用中每个会话里 `gh` 的身份。
- **检出** —— `change` 工单从项目 clone 获得一个工作树和一个 `agent/` 分支；`answer` 工单在只读权限预设下读取
  项目的 live clone，不创建任何分支；已结束工单的工作树在 `worktreeKeepDays`
  （默认 7 天）之后由主机每六小时回收，`scripts/clean-worktrees` 让运维者预览或应用同一规则。磁盘增长是一种失败模式，
  所以它被自动化了。
- **重试** —— 发件箱带退避重试并暴露尝试次数，回复队列显示最久等待与下次尝试，来源会报告下次轮询时间。静默重试循环被
  视为 bug。
- **升级与回滚** —— 五步文档流程、备份 `orchestrator.sqlite` 及其 `-wal`/`-shm`，以及恢复备份并重跑
  `verify-install` 的回滚；日常路径只有在架构前进时才需要备份。

### 信任、安全与 worker 环境

原型把“哪些触发字段可信”留作未决问题。本 fork 回答了它并把答案钉住：来源、线程、actor id、`human`、`addressed`、
渠道、时间、URL、接收范围以及声明的路由元数据是可信的；消息正文、标题、正文、评论、文件、图片、名称与引用的链接不是。
没有任何不可信字段能改变角色、工具列表、Policy、允许名单或请求强度。`tests/trust.spec.ts` 检查两端以及提示词陈述；
提示注入文本不能扩大允许名单。在机器侧，状态数据库与目录是属主独占的，智能体以自己独立的 GitHub 与飞书凭据运行，
worker 环境是有范围限制并被文档化的。凭据仍然比理想状态宽 —— 这是**运维者的明确决定**（经典 `louibot` token 与当前
飞书 secret）；006 记录每个凭据放在哪里、如何轮换。请按哲学中“责任”一节的要求，从很短的允许名单和一个测试仓库开始。

### 工程与分发

`pnpm check` 是唯一的检查：类型检查、87 个 spec 文件以及 tsdown 构建。CI 在 Ubuntu、macOS 与 Windows 上用 Node 22
和 24 运行它（六种组合），`smoke.yml` 在 macOS 上启动真实主机，`release.yml` 打包插件包并附加到 GitHub release。
测试套件共 1502 个测试；它驱动真实定时器与 SQLite，所以每个测试与 hook 的超时是 30 秒；十次连续运行且旁边有并发运行的
Linux 套件，是本 fork 证据的一部分。文档也被测试：[tests/docs.spec.ts](tests/docs.spec.ts) 强制编号文档顺序，并要求
007 列出每个源文件与 spec。插件包保留其配置形态与 CLI 可见行为；0.3.0 把包名与全部注册 id 改为
`dsh-superagent-further`，已有安装按 006 的迁移步骤处理。新增内容是增量设置与面板行，并配有 `CHANGELOG` 与 semver。

### 没有改变的部分

领域模型与词汇（Source、Thread、Trigger、admission、Ticket、Assignment、Report、Attention、Mandate、Policy）、作为
唯一写入者并以 effects/relay/notice 投递的 Engine、提示词组合与编号文档 000–008、`dsh-superagent-further` 包布局，以及面向
运维者的承诺：智能体只在被请求或被允许时行动，只在有人必须行动或可以使用结果时说话。从原型安装迁移会保留其工单、
Thread、决策与结束状态；升级步骤在 006。

## 产品理念的进一步完善

原原则保持不变：**尽可能少占用人的注意力，尽可能多地交付价值。** 日常使用在不增加顶层概念的前提下打磨了五件事：

1. **项目是委派的单位。** 原型要求每个仓库一个安装。团队的工作按项目组织，所以项目变成一条带有本地 clone、仓库与
   基线分支的记录 —— Lead 又让它成为持久会话所拥有的单位。
2. **Lead 是上下文的边界，而不是新的工作类型。** Orchestrator 不应承担项目劳动，执行器也不必知道“部门”。每个项目一个
   持久会话，给了前者一个委派去处，给了后者一个有上下文的父会话，而领域只保留它已有的概念。
3. **Request 是对人的承诺。** 人发出的是请求，不是工单。当一个请求需要多次交付时，Request 保留一次确认、一次结果与
   一个 done 状态 —— 否则人就必须从内部记录里自行拼装结果，那是工具额外制造的注意力。
4. **宁可拒绝，不要猜测。** 有多个项目时，静默地选择一个仓库比拒绝更糟：没有归属的请求在接受阶段被拒绝并提示
   **Execution → Projects**，onboarding 也要求项目。原型隐含的单仓库回退在当时是便利，现在不再有唯一正确答案。
5. **运维也是产品的一部分。** 一个要连续运行数周的工具，评价标准是它的迁移、升级、自检、日志上限、工作树回收、单主机
   规则与可见重试状态，而不仅是它的智能体循环。这就是本 fork 投资于 `verify-install`、架构版本、CI、smoke 主机与发布
   tarball 的原因。

刻意**不**增加的东西：第二条持久消息总线或共享任务板（sqlite 记录加 effects 已经能投递，第二个事实来源要消耗注意力）、
面向依赖的工作流引擎（简单的 `after` 边就是一个属性）、一张工单里的多个执行器（2026-11-08 定案 —— 一单一执行器；跨项目
并行是多张工单）、以及每个新概念都开一个页面（总览列出 Request、Lead 与等待中的工单；健康状态不占空间）。

## 架构速览

```text
src/
  sources/          GitHub、飞书与会话适配器：轮询、接入、线程、触发、渠道、摘要
  app/              运行时、管理 API、面板视图、设置、安装引导、存储、迁移、Lead 记录、
                    项目请求、请求通知、工作树回收
  core/             领域模型与 Engine：准入、工单、派发、报告、决策、effects
  executor/         DshExecutor：启动、投递、槽位、Lead 派发、工作/派发准备
  infra/            worker 环境、shim、命令执行、路径、ACL、批处理 CLI
  client/           Web 面板（React），中英文文本
scripts/            dsh-superagent-further(.cmd)、verify-install(.cmd)、switch-project、clean-worktrees(.cmd)
prompts/            智能体提示词，包括 Lead 的提示词
docs/               编号设计文档、路线图、编排器文档与工程技能笔记
```

一次请求的数据路径是：来源 → 触发（带可信元数据）→ 准入与评估 → 决策 → Request 与 Ticket → 派发给 Lead → 执行器
子智能体 → pull request → 来源观察到合并 → 工单结束 → Request 结果与通知。Engine 写记录；effects 投递确认、回复、
通知与状态变化；面板读取投影，永远不写领域状态。

## 文档

请按顺序阅读编号文档；每篇只依赖它之前的篇章。README 是总览；运行中安装的手册是 006。设计文档目前为英文，链接指向
英文原文。

- [000 哲学](docs/000-philosophy.md)
- [001 领域模型](docs/001-domain.md)
- [002 授权](docs/002-authorization.md)
- [003 执行](docs/003-execution.md)
- [004 提示词](docs/004-prompts.md)
- [005 面板](docs/005-panel.md)
- [006 部署](docs/006-deployment.md)：账号、项目、托管、升级、故障排查
- [007 架构](docs/007-architecture.md)
- [008 食谱](docs/008-cookbook.md)：新增一个来源
- [009 路线图](docs/009-roadmap.md)：从研究原型到日常使用，以及本 fork 已经落地的内容
- [010 项目级编排器](docs/010-project-orchestrator.md)：Orchestrator → Lead → Worker 设计及其决策
- [011 能力](docs/011-capabilities.md)：标签、文件投递、项目请求、安装级自举与 Lead 升级的决策记录
- [012 项目请求](docs/012-project-requests.md)：项目请求、升级与安装级工作的设计
- [AGENTS.md](AGENTS.md)：给在本仓库工作的编程智能体的说明
- [docs/agents/domain.md](docs/agents/domain.md)：配合编程智能体使用的工程技能脚手架

## 开发

```bash
pnpm install --frozen-lockfile
pnpm check        # 类型检查 + 测试 + 构建
```

- Node.js 22.19+ 或 24+，pnpm 11.7.0（见 `packageManager` 字段）。状态数据库与测试使用 `node:sqlite`。
- CI（`.github/workflows/check.yml`）在 Linux、macOS 与 Windows 上用 Node 22 和 24 运行同一条命令，因此只在 Windows
  生效的路径（批处理 CLI、ACL、服务脚本）每次推送都会被运行。`.github/workflows/smoke.yml` 在 macOS 上启动真实主机；
  `.github/workflows/release.yml` 在 `v*` 标签上运行。
- Linux 可以在 WSL 里用 Node 22 与 pnpm 11.7.0 运行；每次推送 CI 都会跑。Windows 上服务脚本是
  `scripts\dsh-superagent-further.cmd`，面板 token 在最新的 `.artifacts/dsh-superagent-further-*.log` 里。
- 新增来源的流程见 [008](docs/008-cookbook.md)；新的源文件与 spec 必须加入 007 的表格，因为 `tests/docs.spec.ts`
  会强制检查。
- 纯文档变更不会触发 `check.yml` 与 `smoke.yml`（`paths-ignore`），因此推送文档前请在本地运行
  `pnpm vitest run tests/docs.spec.ts`。

## 已知限制与后续步骤

- **macOS 有 CI 与 smoke 主机，但没有人工跑过可见面板。** 006 中的发布检查保留了这一步，由人完成；截图在发布时拍摄，
  并刻意不提交，因为它们会显示运维者真实的工作区与账号名。
- **每个状态目录只能有一个主机。** 应用内主机与服务脚本互斥；防护会指出另一个主机，006 记录了切换方式。第二个配置档
  （或 `scripts/switch-project`）是目前把两个项目分别托管的方法。
- **凭据比理想状态宽，这是运维者的决定**（经典 `louibot` token、当前飞书 secret）。升级到仅限测试仓库的细粒度 token
  的路径记录在 006 与 009，但尚未强制执行。
- **现在必须有项目才能启动。** 全新安装在登记项目之前会报告 `projectUnset`，没有项目能承接的已接受请求会被拒绝 ——
  这是设计，并带有指向该页面的提示。
- **一单一执行器。** 工单内的多执行器 fan-out 仍是未来选项；跨项目与多交付的工作改由包含多张工单的 Request 处理。
- **Windows 上跳过的 5 个测试是 POSIX-only 分支**（部署 setup 的假 shell、POSIX 文件模式、POSIX store 检查），
  没有 Windows 等价物；对应的 Windows 测试会在其位置运行，每个跳过都是带注释的 `skipIf`，而不是删除测试。
- 剩余工作的长期顺序、验收标准与证据见 [009 路线图](docs/009-roadmap.md)。

## 许可证

[MIT](LICENSE)。本 fork 保留原型的许可证与署名：原始设计与代码来自 DeepSeek 的 `dsh-superagent-prototype`；
上面描述的改动维护在 `louifinn/dsh-superagent-further`。
