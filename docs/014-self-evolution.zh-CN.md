# 014 — 自进化：运行中发现 superagent 自身的问题（设计）

> 本文是 [docs/014-self-evolution.md](014-self-evolution.md) 的中文对照版；两版内容一致，以英文版为权威文本。

状态：**提案**（2026-11-10）。操作员在源飞书线程提出本机制并确认了下文的三点需求决定；本文档提交审批，仅在批准后按本文的阶段实施。

## 为什么

superagent 日常运行——工单、审查、路由、面板操作——时，各会话经常注意到 superagent 自身的问题：代码缺陷、误导性的提示词、面板缺漏、跑偏的文档、部署摩擦。今天这些观察都会丢失，因为每条进入工作的路径都始于来源消息或自动化投递。操作员的请求（2026-11-10）：

> superagent 在运行过程中能否主动发现 superagent 项目的问题，并根据情况自行选择主动向远程仓库（louifinn/dsh-superagent-further）提交 issue（项目不在 superagent 管辖范围内）或主动产生请求并转化为工单（项目在 superagent 管辖范围内，例如本人的开发环境）？我认为这是一个值得考虑实现的自进化机制。

操作员于 2026-11-10 确认的需求：

| # | 决定 |
| --- | --- |
| 1 | **分流判据。** 问题所属仓库在「执行 → 项目」已登记 → 主动产生请求并开票自修；未登记 → 以 bot 账号向该仓库提交 issue。 |
| 2 | **发现来源。** 默认只做顺带发现；定时自检也要实现，带开关，默认关闭。 |
| 3 | **范围。** 仅限 superagent 自身——代码、提示词、面板、文档与本装置部署——不推广到任意项目。 |

由决定 3，对外目标固定为 superagent 自己的仓库。本装置已把该仓库登记为项目，因此所有范围内的发现都走工单出口；从发布 tarball 安装的装置未登记它，issue 出口是唯一通路。两种形态共用同一套设计。

## 调研结论

- **流入侧已经是主动的，对外侧不是。** 十六条规则类别加 accept mode（`off`/`observe`/`auto`，[002](002-authorization.md)）只管什么*进入*为工作；智能体自己发起的对外动作没有任何门槛。
- **请求链路已覆盖工单出口。** worker 对自己的项目用 `request_create`，其 Lead 处置（[012](012-project-requests.md) D1–D5）；其他项目工单上的 worker 报给所属 Lead，由 `lead_request_escalate` 升级（D13——该工具不要求 automation 来源）；installation 自动化投递走 `orchestrator_request_create`（D12）。缺口是主会话自己的发现：该工具强制要求 automation id。
- **没有创建 issue 的写路径。** GitHub 写操作只有评论（`src/sources/github-channel.ts`）与打标签（`orchestrator_label`），没有创建 Issue 的工具。
- **提 Issue 不会回流成工单。** GitHub Source 丢弃智能体账号自己开的 Issue 和 PR（`src/sources/github.ts` `readNotified` 的 `sameName` 判断），两个出口互不干扰。
- **定时自检的时钟已存在。** installation 级自动化（schema 19/20）向主会话投递常设指令，手动运行（`automation_run`）、删除与对账均已具备。

## 设计

```
发现（顺带发现 | 定时自检）
   │  目标 = superagent 自身，具体且可检验
   ├─ 本装置已登记自身仓库（开发装置）
   │     └─ 工单出口：project_request → Lead 处置 → 工单 → PR → 人审合并
   └─ 本装置未登记自身仓库（发布版装置）
         └─ issue 出口：Orchestrator 以 bot 账号向自身仓库提交 GitHub issue
```

一句话：**发现靠提示词，工单出口复用现有请求链路，issue 出口是一个带独立 observe/auto 门槛与审计记录的新工具，定时自检是现有自动化机制上的一个开关。**

### D1. 发现层（提示词，无代码）

worker、Lead 与 Orchestrator 的提示词各加一小段「自进化」内容：

- **什么算发现。** 做其他工作时遇到的具体、可检验的 superagent 自身问题：代码缺陷、误导性提示词、面板缺陷、跑偏的文档、部署摩擦。主观风格意见与功能愿望不算发现；愿望仍由人提出。
- **只记录，不就地修。** 发现绝不扩大当前工单的范围，与现有的不扩张范围规则一致。
- **按角色分流。** 自身项目工单上的 worker 直接用 `request_create`；其他项目工单上的 worker 报告给所属 Lead，由 Lead 升级；主会话用 discovery 来源（D2）或 issue 出口（D3）；关于本装置运维状态的发现——Source 失败、凭据、卡住的 outbox——走既有"需要你"通道，不进本机制。
- 定时自检开启时使用同一套分流口径。

### D2. 工单出口（复用 + 一个新来源）

同项目与跨项目的发现今天就能走 `request_create` 与升级。一处改动：`orchestrator_request_create` 接受 `via: 'discovery'`——不再要求 automation id——使主会话能处置自己的发现。Mandate 基准 `{ via: 'discovery' }` 与 installation 基准同等被 revalidation 信任，因为没有来源消息为它背书。交付单元仍必须指向已登记项目；自检自动化继续记录其 automation id 以便审计。

### D3. issue 出口：`orchestrator_issue_create`（新工具）

主会话上的单一出口，服务于自身仓库未登记为项目的装置：

- **目标固定。** 代码常量 `SELF_REPOSITORY = 'louifinn/dsh-superagent-further'`，不做设置；本 fork 的 fork 改常量即可。
- **管辖拒绝。** 本装置已登记自身仓库时，工具拒绝并指明工单出口——分流规则由工具硬性执行，不依赖提示词自觉。
- **三档门槛**（Eval 设置里 accept mode 旁）：`off` 不记录不提交；`observe`（默认）只记草稿不提交；`auto` 在限额内直接提交。与流入侧"从窄开始"对称。
- **去重。** 提交前检索目标仓库开放 Issue（标题与关键词）与本装置近 14 天已提交记录；命中则关联而不重复提交。
- **限流。** 每装置每日最多提交 3 个 Issue；超出降级为草稿并在面板说明。
- **内容规范。** 正文遵循仓库语言与约定，首行标注自动代理身份，写明证据、复现步骤与运行版本；不带飞书内容、凭据或私有本地路径。只应用仓库已有标签，默认不打标签。
- **审计记录。** schema 23 新增 `self_report`：
  `{ id, title, body, evidence, raised_by { session, ticket? }, target_repo, status: 'draft' | 'filed' | 'dismissed', issue_number?, filed_at?, created_at }`。
  草稿是人审批的对象；已提交的历史就是远端仓库本身，不再做历史页。这是本设计唯一新增的域记录：一个对外的、可审批的、可去重的产物，既不是 `project_request`（对 Lead 的内向请求）也不是 Outbox（投递回执）。

### D4. 定时自检（开关，默认关，基于自动化）

- 一个设置开关，默认关，在自动化页显示为内置行。
- 开：确保一条内置 installation 自动化——默认每周一 09:00 本地时间，可像普通任务编辑——指令为固定模板：巡检 Source health、outbox 失败、主机日志错误、等待过久的工单与请求、（已登记时）自身仓库 CI，以及未处置的 `self_report` 草稿；发现按 D1 分流——代码与文档问题走 D12 请求（带 automation id）或 issue 出口，运维状态走既有"需要你"通道。
- 关：经现有 `Automations.remove` 路径移除内置任务；对账沿用现有 reconciliation 覆盖漂移。
- 验收用现有 `automation_run` 跑一次真实巡检。

### D5. 面板

Overview 的"需要你"视图新增一组 observe 草稿行——标题、目标仓库、证据摘要、等待时长——各带**批准提交**与**忽略**动作。`auto` 档无积压，无其他界面。

## 非目标

- 发现或路由 superagent 以外项目的问题（决定 3）。
- 任何无人合并：自修工单仍以人审合并的 pull request 收尾。
- 第二消息总线或任务板；Engine 仍是域状态的唯一写入者。
- 已提交 Issue 的历史页；目标仓库即历史。

## 安全与噪声

| 风险 | 对策 |
| --- | --- |
| 幻觉问题被公开提交 | 默认 `observe`；处置的 Lead 或 Orchestrator 必答；正文要求证据与复现；每日上限 |
| 私有内容泄入公开 Issue | 硬性内容规范：无飞书内容、凭据、私有本地路径；正文遵循仓库语言 |
| Issue 或工单重复 | 开放 Issue 检索加 14 天已提交窗口；project request 与升级保持既有幂等 |
| 低价值自修工单泛滥 | 发现静默记录、不发消息；Lead 处置时合并同类；提示词只要求具体可检验的发现 |
| 两个出口重复上报同一问题 | 管辖检查互斥：一个装置、一个自身仓库、一个出口 |
| 权限扩大 | issue 工具只创建 Issue——不关闭、不编辑、不合并；自修仍以人的合并收尾；门槛是可修订的设置 |

## 阶段

每阶段以 `pnpm check` 全绿、六组合 CI 绿与一次真实运行收尾，承仓库的门禁；文档随阶段落地，不最后补 batch。

- **阶段 1 — 发现层（仅提示词，无代码）。** 三段提示词与技能文本；`tests/prompts.spec.ts` 固定。真实证明：一次真实工单在运行中记录一个真实 superagent 发现，并经现有 `request_create` 或升级路径成为自修工单。
- **阶段 2 — issue 出口与 discovery 来源。** schema 23 `self_report`、`orchestrator_issue_create`（管辖拒绝、门槛、去重、限流、内容规范）、`orchestrator_request_create` 的 discovery 来源、Eval 的 self-report mode、Overview 草稿行。真实证明：observe 档真实落一张草稿、批准后向 `louifinn/dsh-superagent-further` 提交一个标注测试的 Issue 并关闭；管辖拒绝由测试覆盖。
- **阶段 3 — 定时自检。** 开关、内置自动化的确保/移除/对账与指令模板。真实证明：开关切换生效，一次 `automation_run` 巡检正确分流发现。
- **阶段 4 — 文档收尾。** 同步 [002](002-authorization.md)、[004](004-prompts.md)、[005](005-panel.md)、[006](006-deployment.md) 与 [007](007-architecture.md)，并更新 CHANGELOG 与 README 计数。

## 随本文提交的决策点

随推荐默认值一并送审；操作员批准时确认或修改：

| # | 决策点 | 推荐 |
| --- | --- | --- |
| 1 | self-report 默认档位 | `observe`；操作员审看草稿后可切 `auto` |
| 2 | 已在本装置自修的发现是否再留公开 Issue | 否——pull request 即公开记录；两处都写会双份留痕 |
| 3 | 定时自检默认周期 | 每周一 09:00 本地时间，可编辑 |
| 4 | 每日提交 Issue 上限 | 每装置 3 个 |

## 风险

- **开发装置上 issue 出口处于休眠**——设计如此，管辖检查把一切送往工单出口。其真实证明（阶段 2）提交一个标注测试的 Issue 后关闭。
- **本 fork 的 fork** 指向常量 `SELF_REPOSITORY`；登记了自己的 fork 的操作员只有在登记仓库等于常量时才走工单出口。记入文档，不做配置。
- **顺带发现依赖提示词纪律。** 提示词由测试固定并像所有提示词文本一样受审；从未被记录的发现不可见——阶段 1 的真实证明直接回应这一点。
