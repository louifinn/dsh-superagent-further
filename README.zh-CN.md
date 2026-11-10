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

## 概述

dsh-superagent-further 是一个自托管的工程智能体，工作在你团队本来就使用的仓库与聊天里。它作为 [DeepSeek Harness](https://www.deepseek.com/en/harness/) 的插件包安装，注册一个或多个项目后，会关注你请求帮助的地方：GitHub 的 issue、pull request、review 与 CI 结果，以及（如果你配置）飞书里的 @ 和私聊。

当团队允许的人提出请求时，智能体会按你的规则判断是否接单，接受为一个 Request，把每个 Ticket 放在独立检出里执行，并在原来的对话里回复——通常是一个你审查并合并的 pull request；问题与 review 的答复也回到原线程。每个项目的 Lead 会话保存该项目的上下文，可以把工作交给 worker，把跨项目的决定升级给 Orchestrator，并在架构级工作开始前等待你记录在案的批准。

你可以用它：

- 把 issue、review 评论或聊天请求变成一个经过审查的 pull request；
- 让智能体调查、审查或解释代码，并在你提问的地方回答；
- 从一个机器人、一块面板推进多个仓库；
- 在面板里批准架构工作、设置变更与升级；
- 让自动化执行常驻指令，并把需要人处理的异常集中呈现出来。

它是 DeepSeek SuperAgent 研究原型的 fork。本 README 说明它能做什么、如何工作、如何安装运行，以及边界在哪里。

## 状态一览

| 项目 | 状态 |
| --- | --- |
| 运行平台 | Windows 10/11 原生（桌面应用或 `scripts\dsh-superagent-further.cmd`）、Linux（WSL 验证 + CI）、macOS（CI + smoke 主机） |
| 依赖 | Node.js `^22.19.0 || >=24`、pnpm `11.7.0`、git 2.32+、DeepSeek Harness `0.2.2-rc.1`（版本固定在 [006](docs/006-deployment.md)）；不需要 Python，不需要 tmux |
| 检查 | `pnpm check`：93 个 spec 文件，**1540 passed / 5 skipped（1545）**，包含类型检查、构建、发布 tarball 的打包检查与生成参考页的一致性检查；每次推送在六种平台/Node 组合上运行 check.yml 且全绿 |
| 发布 | `0.4.0`（[CHANGELOG](CHANGELOG.md)）；推送 `v*` 标签会运行检查、打包 `dsh-superagent-further-0.4.0.tgz` 并发布 |
| 真实验证 | 真实 GitHub 与飞书请求以人为合并的 pull request 结束；一个项目 Lead 作为隐藏子会话执行了真实工单；一个跨项目 Request 产出两张工单、两个 PR，并以一个 `done` 结果收尾 |
| 项目请求 | worker 在工单需要决定、新交付物或其他项目的工作时提出持久的 `project_request`；项目 Lead 必须回复并处置，接受的工作请求会在限定于该项目内创建 Request 与分阶段 Ticket，架构请求等待人记录在案的批准，独立的 DSH 会话可以提交工作并总会收到答复；项目自动化投递可经其 Lead 提出一个项目请求，安装级自动化投递可由主会话创建安装级 Request，Lead 可把本项目之外的工作升级给 Orchestrator 决定 |
| 状态数据库 | 架构版本 23（`10 → 11 → … → 22 → 23` 原地迁移；`scripts/verify-install` 以只读方式报告架构版本） |

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

## 它还能做什么？

原型为一个仓库、一台 POSIX 主机、一位操作者跑通了核心闭环：来源事件成为 Trigger，Policy 准入，Request 变成 Ticket，worker 在原渠道汇报。本 fork 保留这个闭环，并增加下面的能力。每一项都是用户可见的——你可以提出、观察或操作——内部细节由链接的文档承载。

**从不止一个地方工作。** GitHub 的 issue、pull request、review 评论与 CI 结果，加上飞书的 @ 与私聊，都能成为工作。独立的 DeepSeek Harness 会话可以用 `superagent_submit` 交来工作并总会收到答复，飞书会话能收到工作区文档文件，每日摘要会汇总发生过的事。

**从一个机器人运行多个项目。** 每个注册项目带来自己的 clone、仓库与基础分支；GitHub 轮询按项目进行，Ticket 限定在自己的项目内，完成的工作树会被回收。一块面板、一份 Policy 覆盖所有项目，并在有帮助处按项目过滤。

**给每个项目一个 Lead。** 每个项目有一个持久会话：保存项目上下文、接收并回答 worker 的请求、只通过接受这些请求来创建项目 Ticket、为 change 启动独立审查者，并把项目外的工作升级给 Orchestrator。架构级工作要等人在来源线程里记录批准后才进入实施。

**接收系统自己发现的工作。** worker、项目 Lead、安装级自动化与独立会话都能发起持久请求；每条路径都记录来源、必须被回复、会去重，且不能绕过 Policy 或准入。

**知道“完成”意味着什么。** 每个 Ticket 都有交付契约。`change` 工单获得工作树与分支，只能经受关注的 pull request 结束（ready 报告须点名该 PR）；`answer` 工单在去掉写工具后只读项目的 live 检出，并以 completed 结束。报告携带最多 20 项验证检查，显示在工单上并计入通知；Lead 可启动独立的只读审查者，blocked 结论会让已合并的 change 保持开放。面板区分“已回答”与“已交付”。

**无需人盯着也能运行。** 安装级与项目级自动化把常驻指令投递给正确的会话，面板可以运行或删除它们。待批收件箱汇总设置提案，按块恢复可撤销一次改动。记忆是实验性功能，默认关闭；打开后保存置顶事实与近期记录，且只有再打开预注入才随请求携带，语言设置让人读的文字保持在你选择的语言。

**看见需要人处理的事。** Overview 汇总打开的 Request、升级、需要关注的自动化、失败的文件投递，以及每个项目的 Lead；仍在运行却已闲置超过十分钟的 assignment 会变成 attention 并唤醒 Lead 一次；日志页按级别与范围过滤 Host 日志；健康、发件箱与回复队列细节仍然可见；工单显示验证证据与审查状态；执行页显示每个 worker 的后台任务与最后输出。

**像服务一样运维。** 安装向导、Windows/macOS/Linux 服务脚本、`verify-install`、单主机守护与优雅关停让它可无人值守运行。架构版本原地迁移，`scripts/archive-state.mjs` 取一致快照，[运维手册](docs/013-operations-runbook.md)与[安全策略](SECURITY.md)记录日常路径与信任边界。

**不重接管线地扩展。** 来源（GitHub、飞书、DeepSeek Harness 会话）、label 能力、飞书文件投递与操作型 skills（分流、发布、项目请求）都是一等能力；[工具参考](docs/reference/tools.md)与[设置参考](docs/reference/config.md)从代码生成，因此不会漂移。

**并且运行在你所在的地方。** Windows 10/11 原生、Linux 与 macOS；Node 22 与 24；六种平台/Node 组合的 CI、真实主机 smoke 测试，每个版本都可安装。

原型的约束保持不变：Engine 是唯一写入者，智能体只在来源事件、被接受的 Request 或显式请求授权时行动。[009 路线图](docs/009-roadmap.md)记录每项能力何时落地，[011 能力](docs/011-capabilities.md)记录背后的决策。

## 产品理念的进一步完善

原原则保持不变：**尽可能少占用人的注意力，尽可能多地交付价值。** 日常使用在不增加顶层概念的前提下打磨了七件事：

1. **项目是委派的单位。** 原型要求每个仓库一个安装。团队的工作按项目组织，所以项目变成一条带有本地 clone、仓库与
   基线分支的记录 —— Lead 又让它成为持久会话所拥有的单位。
2. **Lead 是上下文的边界，而不是新的工作类型。** Orchestrator 不应承担项目劳动，执行器也不必知道“部门”。每个项目一个
   持久会话，给了前者一个委派去处，给了后者一个有上下文的父会话，而领域只保留它已有的概念。
3. **Request 是对人的承诺。** 人发出的是请求，不是工单。当一个请求需要多次交付时，Request 保留一次确认、一次结果与
   一个 done 状态 —— 否则人就必须从内部记录里自行拼装结果，那是工具额外制造的注意力。
4. **宁可拒绝，不要猜测。** 有多个项目时，静默地选择一个仓库比拒绝更糟：没有归属的请求在接受阶段被拒绝并提示
   **Execution → Projects**，onboarding 也要求项目。原型隐含的单仓库回退在当时是便利，现在不再有唯一正确答案。
5. **运维也是产品的一部分。** 一个要连续运行数周的工具，评价标准是它的迁移、升级、自检、日志上限、工作树回收、单主机
   规则、可见重试状态以及它暴露出来的异常，而不仅是它的智能体循环。这就是本 fork 投资于 `verify-install`、架构版本、
   CI、smoke 主机、发布 tarball、日志页、Overview 的等待行与 013 运维手册的原因。
6. **证据优先于声明。** 智能体说“完成了”是最便宜的一句话，也是最难信任的；所以产品在接缝处要求证据：change 工单只能
   经受关注的 PR 结束，ready 报告携带验证它的检查；answer 工单的报告就是交付物；独立审查者可以用记录在工单上的结论
   阻止合并。
7. **系统必须能向下一个智能体解释自己。** 下一个读代码的智能体看不到产生它的对话。所以决策写入编号文档，工具参考页从
   代码生成，打包与分层规则被检查，[CONTRIBUTING.md](CONTRIBUTING.md) 为人、普通编码智能体、Orchestrator、Lead、
   Worker 与 Reviewer 写明同一套流程。

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
- [013 运维手册](docs/013-operations-runbook.md)：日常检查、状态备份、故障恢复与升级
- [014 自进化](docs/014-self-evolution.md)（[中文对照](docs/014-self-evolution.zh-CN.md)）：运行中发现 superagent 自身问题并按管辖分流为自修工单或上游 Issue 的设计
- [SECURITY.md](SECURITY.md)：信任边界与漏洞报告方式
- [CONTRIBUTING.md](CONTRIBUTING.md)：面向人、普通编码智能体，以及 Orchestrator、Lead、Worker、Reviewer 的协作流程、检查门禁与交接规范
- [工具参考](docs/reference/tools.md)：从模型看到的工具工厂生成
- [设置参考](docs/reference/config.md)：设置块生成的 JSON Schema
- [AGENTS.md](AGENTS.md)：给在本仓库工作的编程智能体的说明
- [docs/agents/domain.md](docs/agents/domain.md)：配合编程智能体使用的工程技能脚手架

## 开发

完整流程、检查门禁与各角色统一的汇报模板见 [CONTRIBUTING.md](CONTRIBUTING.md)。

```bash
pnpm install --frozen-lockfile
pnpm check        # 类型检查 + 测试 + 构建 + 打包检查 + 生成文档检查
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

