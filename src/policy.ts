/**
 * Runtime settings schemas, assessment validation, and policy gate evaluation.
 * Who may originate work is configured per Source in that Source's own identities; the Policy never maps a person across Sources.
 */
import { LIMITS } from './limits.ts'
import { z } from 'zod'
import { ADMISSION_DEFAULTS, type Admission, type AdmissionCell, type AdmissionRow } from './admission.ts'
import { key, type AssessmentOutcome, type Mandate, type Policy, type PolicyEffect, type SourceScope, type Strength, type Thread, type Ticket,
  type Trigger, type ActorRef, type GateResult } from './core/index.ts'
import { sameName } from './infra/text.ts'
import { WORKER_COMMANDS } from './infra/environment.ts'
import { isAbsolutePath } from './infra/paths.ts'
import { ProjectsSchema } from './projects.ts'

export const RuleIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
export const RuleMatchSchema = z.object({ rule_id: RuleIdSchema, reason: z.string().trim().min(1).max(500) }).strict()
export type RuleMatch = z.infer<typeof RuleMatchSchema>
export const RuleAssessmentSchema = RuleMatchSchema.extend({ matched: z.boolean() }).strict()
export type RuleAssessment = z.infer<typeof RuleAssessmentSchema>
/**
 * An assessment's judgment that the request is actionable. For review and read-only research/report/question rules,
 * `implementation_requested` records that the requested deliverable — the review, report or answer — was asked for;
 * otherwise it records a requested change. In both cases `target_basis` names what settles the target.
 */
export const AdmissionDirectionSchema = z.object({
  implementation_requested: z.boolean(),
  target_basis: z.enum(['specified', 'existing-standard', 'undetermined']),
  requires_design_decision: z.boolean(),
  evidence: z.string().trim().min(1).max(700),
}).strict()
export type AdmissionDirection = z.infer<typeof AdmissionDirectionSchema>
/** Check whether an assessment established implementation intent and a settled target without open design decisions. */
export function directionAllowed(value: unknown): value is AdmissionDirection {
  const result = AdmissionDirectionSchema.safeParse(value)
  return result.success && result.data.implementation_requested && result.data.target_basis !== 'undetermined' && !result.data.requires_design_decision
}
export interface Assessment {
  decision: 'accept' | 'ignore' | 'unavailable'; rule_assessments: RuleAssessment[]; direction: unknown
  title: string; scope: string; reason: string; intent_evidence?: string | null; acknowledgement?: string | null; worktree_name?: string
  /** What an accepted Ticket owes: a pull request (change, the default) or a read-only answer (nswer). */
  deliverable?: 'change' | 'answer'
  project?: string
}
/**
 * Validate an assessment against enabled rules and convert it into an engine `AssessmentOutcome`.
 * Acceptance requires a settled direction, at least one matched enabled rule, and `intent_evidence`, and accepts an
 * inferred candidate only in `auto` mode (otherwise recording it as `would_accept`).
 * @throws when `rule_assessments` does not cover every enabled rule exactly once, or an accept omits `intent_evidence`.
 */
export function assessmentOutcome(assessment: Assessment, settings: Pick<Settings, 'policy' | 'eval'>, strength: Strength): AssessmentOutcome {
  const enabled = settings.policy.rules.filter(rule => rule.enabled)
  const judged = assessment.rule_assessments
  const ids = new Set(judged.map(item => item.rule_id))
  if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some(rule => !ids.has(rule.id))) {
    throw new Error('Exactly one assessment for every enabled rule is required; disabled, unknown or missing rule IDs are not allowed')
  }
  const matches = judged.filter(item => item.matched).map(({ rule_id, reason }) => ({ rule_id, reason }))
  const evidence = assessment.intent_evidence ? { intent_evidence: assessment.intent_evidence } : {}
  const audit = { matches, rule_assessments: judged, direction: assessment.direction, ...evidence }
  if (assessment.decision !== 'accept') return { kind: assessment.decision, reason: assessment.reason, audit }
  if (!directionAllowed(assessment.direction)) return { kind: 'ignore', audit, reason: { code: 'directionUnsettled' } }
  if (!matches.length) return { kind: 'ignore', audit, reason: { code: 'noRuleMatched' } }
  if (!assessment.intent_evidence) throw new Error('Acceptance requires intent_evidence')
  const { title, scope, worktree_name: name } = assessment
  const deliverable = assessment.deliverable ?? 'change'
  if (strength === 'inferred' && settings.eval.mode !== 'auto') {
    const proposal = { title, scope, worktree_name: name, deliverable }
    return { kind: 'ignore', audit: { ...audit, would_accept: true, proposal }, reason: { code: 'observed', values: { text: assessment.reason } } }
  }
  return { kind: 'accept', title, scope, reason: assessment.reason, deliverable, ...(assessment.acknowledgement ? { acknowledgement: assessment.acknowledgement } : {}),
    ...(assessment.project ? { project: assessment.project } : {}),
    rules: matches.map(match => match.rule_id), audit, ...(name ? { name } : {}) }
}
/** An assessment rule; its instruction may also specify PR reviewers and whether to wait for their approval. */
export const RuleSchema = z.object({ id: RuleIdSchema, name: z.string().trim().min(1).max(LIMITS.ruleName), enabled: z.boolean(),
  instruction: z.string().trim().min(1).max(LIMITS.ruleInstruction) }).strict()
export type Rule = z.infer<typeof RuleSchema>
/**
 * The built-in rules as they shipped before the rule set was localized. These exact texts are the migration baseline:
 * a stored rule whose id, name and instruction still match one of them was never edited by the operator.
 */
export const LEGACY_DEFAULT_RULES: readonly Rule[] = [
  { id: 'copy', name: 'Copy fixes', enabled: true, instruction: 'Explicit requests to correct a typo, wording, punctuation or existing translation. Preserve product promises and business meaning.' },
  { id: 'visual', name: 'Visual fixes', enabled: true, instruction: 'Explicit implementation requests for local spacing, alignment, overflow or styling, with a specified target or an objectively established existing standard/correct state to restore. Locating an element or calling it inconsistent, unattractive or hard to understand does not establish a target. Do not invent visual style, information hierarchy, rendering or interaction decisions. No redesign, new interaction or behavior. A known spacing defect does not authorize adjacent undefined restyling; assess only a clearly separable authorized scope. If direction or scope is unsettled, observe only: no acknowledgement, worker or unsolicited question.' },
]
/**
 * The built-in rule set: localized copy and visual rules plus categories for defect fixes, feature work, documentation,
 * tests and CI, refactors and performance, research, reviews, read-only questions, SuperAgent settings changes,
 * project automation tasks, dependency and toolchain upgrades, review-feedback fixes, Issue/PR triage, and
 * design/architecture decisions. Every built-in rule ships enabled. Each rule states the boundary between an explicit
 * request with an objectively checkable goal and work accepted on clear intent whose scope the worker then pins down with
 * a question; review, research and design rules expect a report or decision document instead of a code change.
 */
export const DEFAULT_RULES: Rule[] = [
  { id: 'copy', name: '文案纠错', enabled: true, instruction: '针对明确的错别字、措辞、标点或既有翻译错误的修正请求，对象限于被指出的文本，并保留产品承诺与业务含义。目标文本与错误可客观确认即可接单；仅凭读起来别扭、不好看或不够专业不构成请求。措辞或范围有疑问时先接单，再在工单内向提出者提问钉住，不擅自改写未指出的文案。' },
  { id: 'visual', name: '视觉修正', enabled: true, instruction: '针对明确的局部间距、对齐、溢出或样式修正实现请求，目标须被明确指定，或存在可客观确认的既有标准/正确状态可供恢复。仅指出元素位置，或称其不一致、不好看、难理解，都不构成目标；不得自行发明视觉风格、信息层级、渲染或交互决策，不做改版、新交互或行为变更。已知的间距缺陷不授权对相邻未定义的样式一并改动，只评估清晰可分的授权范围。方向或范围未定时保持观察：不确认、不派单、不主动提问。' },
  { id: 'bugfix', name: '缺陷修复', enabled: true, instruction: '针对可复现、可客观判定的缺陷（错误行为、异常、崩溃、回归、数据错误等）的明确修复请求。受影响行为与期望结果可确认即可接单；根因与修复位置不必已经确定，由工单调查。复现步骤或范围不完整时先接单，再在工单内用提问补齐，不擅自扩大修复范围，不借机重构或改动无关行为。' },
  { id: 'feature', name: '功能实现', enabled: true, instruction: '针对明确、可客观判定的功能实现请求（新增或调整一项具体能力）。目标行为与验收方式可确认即可接单；若产品取舍或方案方向仍有互斥选项、需要设计决策，则不接单并保持观察。方向已定而实现细节未定时先接单，再在工单内用提问钉住边界；不自行扩展功能、公开接口或交互。' },
  { id: 'docs', name: '文档/配置/脚本', enabled: true, instruction: '针对明确的文档、配置或脚本修正/补充请求，目标文件或内容可客观确认（如过时说明、错误示例、失效配置、脚本缺陷）。仅笼统表示文档需要完善不构成请求。范围未定时先接单，再在工单内用提问钉住；不改动无关文档，不借机重写结构、调整项目约定或改变配置语义。' },
  { id: 'tests', name: '测试与 CI 修复', enabled: true, instruction: '针对明确的测试或 CI 修复请求（失败用例、错误或脆弱的断言、缺失的回归测试、构建或流水线故障等）。失败的用例/任务及其期望状态可客观确认即可接单；无法本地复现时先接单再提问补齐环境信息。修复须保持或加强检查，不得通过放宽断言、删除用例、跳过检查或屏蔽告警来让它变绿，不擅自扩大 CI 配置改动。' },
  { id: 'refactor', name: '重构/性能', enabled: true, instruction: '针对明确且可客观判定的重构或性能改进请求（去重、调整结构、降低复杂度、修复可测量的性能问题），除明确授权外不得改变既有行为与公开接口。目标模块/热点及其判定依据（基准、复杂度或重复代码证据）可确认即可接单；没有可验证目标的泛泛清理不接单。范围未定时先接单再提问钉住，不进行无关重写或大范围改版。大规模重构（跨模块、跨项目或需要迁移路径）不直接在本工单实施：先按 design 规则产出分阶段计划、回滚点与验收点，交操作员确认后由后续普通工单逐阶段承接。' },
  { id: 'research', name: '调研与报告', enabled: true, instruction: '只读的调研与报告请求：针对明确的问题或决策，产出可客观判定的结论、对比或建议。调研对象与期望产出可确认即可接单；问题含糊或对象不明时先接单，再在工单内用提问钉住。只读：不修改代码、配置或文档；把结论、依据与未决问题写入报告并回复，不擅自实施调研中发现的改动。' },
  { id: 'review', name: '审查（全仓或局部变更）', enabled: true, instruction: '针对明确审查对象（整个仓库、某个 PR/分支/提交或局部变更）的只读审查请求，产出可客观判定的问题清单与结论。审查对象可定位即可接单；范围或关注点不完整时先接单，再在工单内用提问钉住。只读：不修改被审查内容，除非另行明确授权修复；按严重度列出问题与依据，也可以给出未发现问题的结论。' },
  { id: 'qa', name: '只读调研问答', enabled: true, instruction: '针对代码、仓库或项目现状的明确只读问题的回答请求（如某功能在哪实现、为什么出现某个行为）。问题可客观回答即可接单；问题含糊时先接单，再在工单内用提问钉住，不猜测。只读：不改动文件、不创建分支或 PR；以简明回答回复提问并给出文件或行为依据；需要改动才能回答时说明边界，交由提出者决定。' },
  { id: 'settings', name: '更改 SuperAgent 配置', enabled: true, instruction: '针对本部署 SuperAgent 自身配置的明确更改请求（如执行、评估、记忆、语言等设置块的开关与取值），只能通过受控的设置提案完成：提出可回滚的提案并说明影响，由操作员在面板明确批准后生效；范围仅限可安全热更改的字段，不得直接修改仅限面板的字段、绕过确认、审计或版本历史。目标字段与期望值可客观确认即可接单；方向已定而取值未定时先接单，再在工单内用提问钉住，不擅自更改无关设置或项目。' },
  { id: 'automation', name: '项目 dsh 自动化任务', enabled: true, instruction: '针对项目 dsh 自动化任务的明确新增、更改或删除请求（项目内的长期指令与重复计划），只能在显式人工请求下通过自动化工具操作：仅作用于明确所指的项目与任务，遵守 Host 限额（最多 20 条、标题不超过 120 字符、指令不超过 4000 字符、rrule 格式合法），项目任务按 report-only 投递、不得因此修改仓库。目标与计划可确认即可接单；计划未定时先接单，再在工单内用提问钉住，删除或暂停前先确认对象，不擅自扩大范围或改为安装级任务。' },
  { id: 'deps', name: '依赖与工具链升级', enabled: true, instruction: '针对明确可验收的依赖或工具链升级请求（package.json/lockfile 中的具体包版本、Node 或 pnpm engines、CI action 小版本，或机器人开启的 patch/minor 升级 PR）。只改依赖声明、lockfile 以及为让升级通过所必需的适配；升级后项目测试与 CI 必须通过，不顺手升级未点名的依赖、不改变公开行为。主版本升级、替换依赖、涉及原生扩展或安全公告的升级需要设计决策，不直接接单，保持观察或转为方案提案。目标版本与验收方式可确认即可接单；范围未定时先接单，再在工单内用提问钉住。' },
  { id: 'pr-feedback', name: '审查意见修复', enabled: true, instruction: '针对智能体自己的 PR 上、由允许名单中的具名 reviewer 提出的修改意见（评论或 review 请求修改）的修复请求。只修改被明确指出的文件与行为，逐条回应或修复，不扩大到未被指出的重构；保持已通过的检查通过，必要时补充覆盖该修复的测试；不自行合并、不关闭讨论，合并仍由人决定。意见可定位即可接单；含义不明时先接单，再在工单内用提问钉住，不猜测 reviewer 意图。' },
  { id: 'triage', name: 'Issue/PR 分流', enabled: true, instruction: '针对 Issue 或 PR 分流的明确请求：判断其类别、严重度或优先级，给出指派与下一步建议，仅在明确授权时通过 orchestrator_label 增删仓库中已存在的 label。分流对象可定位即可接单；只读判断，不改代码、不关闭、不合并、不承诺修复，也不创建新 label。未经明确授权只输出建议而不改动对象；授权后的改动仅限仓库中已存在的 label。' },
  { id: 'design', name: '方案设计与架构决策', enabled: true, instruction: '针对明确的设计或架构决策请求（大规模重构方案、跨项目边界、技术选型、迁移路径），产出可客观评审的决策文档：问题与约束、备选方案及取舍、影响面（项目、接口、数据、回滚）、分阶段实施计划与验收点；只读仓库与文档，不在本工单直接实施大规模改动。目标决策与约束可确认即可接单；备选方案未收敛时先接单，在工单内以提问钉住约束与评价标准，不预设结论。方案交操作员确认后，实施由后续普通工单承接；跨项目部分拆成 Request。决策文档写入仓库；若评审的管理者不在本机，可按需用 orchestrator_send_file 把文档发送到其飞书会话。' },
]
/**
 * The built-in set as it shipped in 0.3.0: the same ten texts, of which only copy and visual were enabled. An install
 * that still keeps exactly this set is upgraded to DEFAULT_RULES, so the newer categories arrive enabled.
 */
const PREVIOUS_DEFAULT_RULES: readonly Rule[] = DEFAULT_RULES
  .filter(rule => rule.id !== 'settings' && rule.id !== 'automation' && rule.id !== 'deps' && rule.id !== 'pr-feedback' && rule.id !== 'design' && rule.id !== 'triage')
  .map(rule => ({ ...rule, enabled: rule.id === 'copy' || rule.id === 'visual' }))
/**
 * The built-in set as it shipped before the dependency, review-feedback and design rules: twelve enabled categories.
 */
const INTERIM_DEFAULT_RULES: readonly Rule[] = DEFAULT_RULES
  .filter(rule => rule.id !== 'deps' && rule.id !== 'pr-feedback' && rule.id !== 'design' && rule.id !== 'triage')
  .map(rule => ({ ...rule }))
/** The built-in set as it shipped before the triage rule: fifteen enabled categories. */
const FIFTEEN_DEFAULT_RULES: readonly Rule[] = DEFAULT_RULES
  .filter(rule => rule.id !== 'triage')
  .map(rule => ({ ...rule }))
/** Whether `rule` still carries `seed`'s original name and instruction, i.e. the operator never edited that rule's text. */
const untouched = (rule: Rule, seed: Rule): boolean => rule.id === seed.id && rule.name === seed.name && rule.instruction === seed.instruction
/** Whether `rules` is exactly the untouched pre-localization built-in pair, in its original order and enabled state. */
const untouchedDefaults = (rules: readonly Rule[]): boolean => rules.length === LEGACY_DEFAULT_RULES.length
  && rules.every((rule, index) => untouched(rule, LEGACY_DEFAULT_RULES[index]!) && rule.enabled === LEGACY_DEFAULT_RULES[index]!.enabled)
/** Whether `rules` is exactly the untouched 0.3.0 built-in set, in its original order and enabled state. */
const untouchedPreviousDefaults = (rules: readonly Rule[]): boolean => rules.length === PREVIOUS_DEFAULT_RULES.length
  && rules.every((rule, index) => untouched(rule, PREVIOUS_DEFAULT_RULES[index]!) && rule.enabled === PREVIOUS_DEFAULT_RULES[index]!.enabled)
/** Whether `rules` is exactly the untouched twelve-category set shipped before this change. */
const untouchedInterimDefaults = (rules: readonly Rule[]): boolean => rules.length === INTERIM_DEFAULT_RULES.length
  && rules.every((rule, index) => untouched(rule, INTERIM_DEFAULT_RULES[index]!) && rule.enabled === INTERIM_DEFAULT_RULES[index]!.enabled)
/** Whether `rules` is exactly the untouched fifteen-category set shipped before the triage rule. */
const untouchedFifteenDefaults = (rules: readonly Rule[]): boolean => rules.length === FIFTEEN_DEFAULT_RULES.length
  && rules.every((rule, index) => untouched(rule, FIFTEEN_DEFAULT_RULES[index]!) && rule.enabled === FIFTEEN_DEFAULT_RULES[index]!.enabled)
/**
 * Upgrade stored rules to the built-in set, idempotently. A list that is exactly an untouched earlier built-in set
 * (the legacy pair, the 0.3.0 set, the twelve-category set or the fifteen-category set) becomes the whole current
 * default set, so existing installations gain the new categories and their enabled state; otherwise only individually
 * untouched built-in rules are rewritten in place, keeping their enabled state. A rule the operator renamed or edited is
 * preserved as it is; migration never adds a category, enables a rule or resurrects one the operator removed.
 */
export function upgradeRules(rules: Rule[]): Rule[] {
  if (untouchedDefaults(rules) || untouchedPreviousDefaults(rules) || untouchedInterimDefaults(rules)
    || untouchedFifteenDefaults(rules)) return DEFAULT_RULES.map(rule => ({ ...rule }))
  return rules.map(rule => {
    const seed = LEGACY_DEFAULT_RULES.find(item => untouched(rule, item))
    if (!seed) return { ...rule }
    const localized = DEFAULT_RULES.find(item => item.id === seed.id)!
    return { ...rule, name: localized.name, instruction: localized.instruction }
  })
}
const RulesSchema = z.array(RuleSchema)
  .refine(rules => new Set(rules.map(rule => rule.id)).size === rules.length, 'Duplicate rule IDs')
  .transform(upgradeRules)
export const RoleModelSchema = z.object({ provider: z.string().trim().min(1), model: z.string().trim().min(1), reasoningEffort: z.string().trim().min(1).optional() }).strict()
export type RoleModel = z.infer<typeof RoleModelSchema>

export const AllowedSchema = z.object({ id: z.string().trim().min(1).max(200), name: z.string().trim().max(100).optional() }).strict()
const Weak = z.enum(['inferred', 'ignore'])
export const AdmissionRowSchema: z.ZodType<AdmissionRow> = z.object({ listedUnaddressed: Weak.optional(), unlistedAddressed: z.enum(['explicit', 'inferred', 'ignore']).optional(), unlistedUnaddressed: Weak.optional() }).strict()
export const AdmissionTableSchema = z.record(z.string(), AdmissionRowSchema)
export const SourcePolicySchema = z.object({ allowed: z.array(AllowedSchema).default([]), admission: AdmissionTableSchema.default({}) }).catchall(z.unknown())
export type SourcePolicy = z.infer<typeof SourcePolicySchema>
export const PolicyConfigSchema = z.object({
  rules: RulesSchema.default(DEFAULT_RULES),
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourcePolicySchema).default({}),
}).strict()
export const EvalConfigSchema = z.object({
  mode: z.enum(['off', 'observe', 'auto']).default('observe'),
  timeoutSeconds: z.number().int().min(LIMITS.evalTimeoutSeconds.min).max(LIMITS.evalTimeoutSeconds.max).default(120),
  model: RoleModelSchema.nullable().default(null),
}).strict()
const CommandNameSchema = z.string().regex(/^[A-Za-z0-9._-]+$/).refine(name => name !== '.' && name !== '..', 'Not a command name')
  .refine(name => !WORKER_COMMANDS.includes(name), `${WORKER_COMMANDS.join(', ')} cannot be blocked`)
/** Executor settings: worker model, concurrency, ticket directory root (empty defaults to `<stateDir>/work`), `prepare` command, blocked commands, and the registered projects. */
export const ExecutorConfigSchema = z.object({
  model: RoleModelSchema.nullable().default(null),
  maxWorkers: z.number().int().min(LIMITS.maxWorkers.min).max(LIMITS.maxWorkers.max).default(3),
  /// How many executors one project may run at once; the global maxWorkers still caps the whole host.
  projectWorkers: z.number().int().min(LIMITS.projectWorkers.min).max(LIMITS.projectWorkers.max).default(2),
  directory: z.string().trim().refine(path => path === '' || isAbsolutePath(path), 'An absolute path, or empty for <stateDir>/work').default(''),
  prepare: z.string().max(LIMITS.prepareCommand).default(''),
  blockedCommands: z.array(CommandNameSchema).default([]),
  /// Local workspaces and remote repositories; a Ticket belongs to one project and is checked out inside it.
  projects: ProjectsSchema.default([]),
  /// How long a finished Ticket's worktree and branch stay for inspection; 0 keeps them.
  worktreeKeepDays: z.number().int().min(0).max(LIMITS.worktreeKeepDays.max).default(7),
}).strict()
export const SourceInstanceSchema = z.object({ enabled: z.boolean().default(true), config: z.record(z.string(), z.unknown()).default({}) }).strict()
/**
 * Memory behavior, edited on the management panel's Memory page. Memory is an experimental feature and is off by
 * default: `enabled` is the master switch (no injection, no tools, no automatic writes) and must be turned on before
 * anything runs; `inject` additionally carries pinned and recent memories in the runtime-context snapshot and is off
 * by default too, so an operator opts in to the extra context separately; `autoWrite` records a finished Ticket or
 * Request without a model call. The limits bound that snapshot and the retention of old rows.
 */
export const MemoryConfigSchema = z.object({
  enabled: z.boolean().default(false),
  inject: z.boolean().default(false),
  autoWrite: z.boolean().default(true),
  /// Pinned memories always carried, up to this many.
  pinnedLimit: z.number().int().min(0).max(LIMITS.memoryPinned).default(LIMITS.memoryPinned),
  /// The most recent unpinned memories carried after the pinned ones.
  recentLimit: z.number().int().min(0).max(LIMITS.memoryPromptRows).default(LIMITS.memoryPromptRows),
  /// The snapshot's character budget; the configurable maximum keeps one snapshot from dominating attention.
  promptChars: z.number().int().min(0).max(LIMITS.memoryPromptCharsMax).default(LIMITS.memoryPromptChars),
  /// Automatic memories drop after this many days; memories can also carry their own expiry.
  retentionDays: z.number().int().min(LIMITS.memoryKeepDays.min).max(LIMITS.memoryKeepDays.max).default(30),
}).strict()
/** The default language for words a person reads (docs/006 "Language"); free text so any language name works. */
export const LanguageConfigSchema = z.object({
  default: z.string().trim().min(1).max(LIMITS.languageName).default('简体中文'),
}).strict()
export const SettingsSchema = z.object({
  paused: z.boolean().default(false),
  sources: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), SourceInstanceSchema).default({}),
  policy: PolicyConfigSchema.default(() => PolicyConfigSchema.parse({})),
  eval: EvalConfigSchema.default(() => EvalConfigSchema.parse({})),
  executor: ExecutorConfigSchema.default(() => ExecutorConfigSchema.parse({})),
  memory: MemoryConfigSchema.default(() => MemoryConfigSchema.parse({})),
  language: LanguageConfigSchema.default(() => LanguageConfigSchema.parse({})),
}).strict()
export type Settings = z.infer<typeof SettingsSchema>
export type MemoryConfig = Settings['memory']
export type LanguageConfig = Settings['language']
export type SettingsBlock = 'policy' | 'eval' | 'executor' | 'memory' | 'language' | `source:${string}`
export type SettingsSave = SettingsBlock | 'pause'
export type SettingsOrigin = 'panel' | 'tool' | 'sync'
/**
 * Who may change one settings field: `A` saves directly from the main Session's tool, `B` changes who is heard, what is
 * accepted, cost, memory, or language and needs the operator's confirmation, and `C` defines the execution environment
 * or credentials and stays panel-only (docs/011 Part A).
 */
export type FieldTier = 'A' | 'B' | 'C'
/** Tier-A Source config fields: they change how much or how often the Source works, never what it accepts. */
const SOURCE_TIER_A = new Set(['pollSeconds', 'failuresBeforeError', 'observeIssues', 'observePulls', 'observeComments', 'observeCi',
  'readPageSize', 'linkTimeoutMs', 'digestHour'])
/** Tier-B Source config fields: who the Source listens to and what it does on the operator's behalf. */
const SOURCE_TIER_B = new Set(['chats', 'directMessages', 'otherChats', 'digestChat'])
/**
 * The tier of one changed field, named as `changedPaths` reports it (`eval.mode`, `sources.github.config.pollSeconds`).
 * Unknown fields are panel-only, so adding a setting without a tier cannot widen what a tool may save.
 */
export function fieldTier(block: SettingsSave, path: string): FieldTier {
  if (block === 'pause') return 'A'
  if (block === 'policy') return 'B'
  if (block.startsWith('source:')) {
    const prefix = `sources.${block.slice('source:'.length)}.`
    const rest = path.startsWith(prefix) ? path.slice(prefix.length) : path
    if (rest === 'enabled') return 'B'
    if (rest.startsWith('config.')) {
      const field = rest.slice('config.'.length).split('.')[0] ?? ''
      if (SOURCE_TIER_A.has(field)) return 'A'
      if (SOURCE_TIER_B.has(field)) return 'B'
    }
    return 'C'
  }
  if (block === 'eval') return path === 'eval.timeoutSeconds' ? 'A' : 'B'
  if (block === 'executor') {
    if (path === 'executor.worktreeKeepDays') return 'A'
    if (path === 'executor.directory' || path === 'executor.prepare' || path.startsWith('executor.blockedCommands')
      || path.startsWith('executor.projects')) return 'C'
    return 'B'
  }
  // Memory and language are operator preferences. Anything else is a block with no assigned tier, so panel-only.
  if (block === 'memory' || block === 'language') return 'B'
  return 'C'
}

export const POLICY_REVISION = 'mandate-v3'
/**
 * Compute a version hash for settings that affect work authorization.
 * Changes to models, concurrency, pause state, or polling intervals do not invalidate existing decisions.
 */
export function policyVersion(settings: Settings): string {
  return key(POLICY_REVISION, JSON.stringify({ rules: settings.policy.rules, mode: settings.eval.mode, sources: settings.policy.sources }))
}
export function allowedSender(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  return settings.policy.sources[actor.source]?.allowed.find(entry => sameName(entry.id, actor.id))
}
/** Look up `actor` in the Source's `bots` policy list (validated by the Source's kind), whose messages are admitted as inferred candidates at most. */
export function listedBot(settings: Settings, actor: ActorRef): z.infer<typeof AllowedSchema> | undefined {
  const bots = z.array(AllowedSchema).catch([]).parse(settings.policy.sources[actor.source]?.bots ?? [])
  return bots.find(entry => sameName(entry.id, actor.id))
}
export const anyoneAllowed = (settings: Settings): boolean => Object.values(settings.policy.sources).some(part => part.allowed.length > 0)
const senderName = (entry: z.infer<typeof AllowedSchema>): string => entry.name || entry.id

/** Check whether a thread has tickets of its own (excluding context-only subscriptions). */
const participating = (thread: Thread, tickets: Ticket[]): boolean =>
  [...thread.subscriptions, ...tickets.map(ticket => ticket.id)].some(id => !thread.context?.includes(id))
const listened = (sources: SourceScope, source: string, meta: Record<string, unknown>) => sources.scope({ source, meta })

function admissionCell(allowed: boolean, addressed: boolean): AdmissionCell | undefined {
  return allowed ? addressed ? undefined : 'listedUnaddressed' : addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
}
function admissionOf(settings: Settings, source: string, row: string | undefined, cell: AdmissionCell): Admission {
  return (row === undefined ? undefined : settings.policy.sources[source]?.admission[row]?.[cell]) ?? ADMISSION_DEFAULTS[cell]
}
const STRENGTH: Readonly<Record<Admission, number>> = { ignore: 0, inferred: 1, explicit: 2 }

/** Compute how a settings change from `old` to `now` affects the authorization or matched rules of each open ticket. */
export function policyEffects(tickets: readonly Ticket[], old: Settings, now: Settings, scope: (settings: Settings) => SourceScope):
  Map<string, PolicyEffect> {
  const before = settingsPolicy(old, scope(old)), after = settingsPolicy(now, scope(now))
  const effects = new Map<string, PolicyEffect>()
  for (const ticket of tickets) {
    const rules = (ticket.mandate.basis.rules ?? []).flatMap((id): NonNullable<PolicyEffect['rules']> => {
      const was = old.policy.rules.find(rule => rule.id === id), is = now.policy.rules.find(rule => rule.id === id)
      if (!is?.enabled) return was?.enabled ? [{ id, name: was.name, change: 'disabled' }] : []
      return JSON.stringify(was) === JSON.stringify(is) ? [] : [{ id, name: is.name, change: 'changed', instruction: is.instruction }]
    })
    const effect: PolicyEffect = rules.length ? { rules } : {}
    if (before.revalidate(ticket.mandate) && !after.revalidate(ticket.mandate)) {
      // With the previous accept mode and rules, the Mandate holds unless the sender or receiving scope lost authorization.
      const asBefore = { ...now, eval: old.eval, policy: { ...now.policy, rules: old.policy.rules } }
      if (!settingsPolicy(asBefore, scope(now)).revalidate(ticket.mandate)) {
        Object.assign(effect, { requesterAllowed: false, requester: ticket.mandate.actor })
      } else if (ticket.mandate.strength === 'inferred' && old.eval.mode === 'auto' && now.eval.mode !== 'auto') effect.proactive = false
    }
    if (Object.keys(effect).length) effects.set(ticket.id, effect)
  }
  return effects
}
/** Build the active Policy for gating incoming Triggers and revalidating existing Ticket Mandates. */
export function settingsPolicy(settings: Settings, sources: SourceScope): Policy {
  const version = policyVersion(settings)
  const mode = settings.eval.mode
  /** Gate non-human triggers: only listed bots (as inferred candidates) and senderless system/CI events may pass; other bots are rejected. */
  const machineGate = (trigger: Trigger): GateResult => {
    const bot = trigger.actor.id ? listedBot(settings, trigger.actor) : undefined
    if (trigger.actor.id && !bot) return { admissible: false, reason: 'not_human' }
    const scope = listened(sources, trigger.source, trigger.meta)
    if (!scope.listened || !(trigger.addressed || scope.observed)) return { admissible: false, reason: 'not_human' }
    const recorded = { source: trigger.source, scope: trigger.meta, ...scope.row === undefined ? {} : { row: scope.row } }
    const addressed = trigger.addressed ? { addressed: trigger.addressed } : {}
    if (bot) {
      if (mode === 'off') return { admissible: false, reason: 'admission_ignored' }
      const basis = { ...recorded, via: 'bot' as const, sender: senderName(bot), ...addressed, observation: { mode } }
      return { admissible: true, strength: 'inferred', basis }
    }
    const cell = 'unlistedUnaddressed' as const
    if (admissionOf(settings, trigger.source, scope.row, cell) !== 'inferred' || mode === 'off') {
      return { admissible: false, reason: 'admission_ignored' }
    }
    return { admissible: true, strength: 'inferred', basis: { ...recorded, via: 'admission', cell, observation: { mode } } }
  }
  return {
    version, paused: settings.paused, evalTimeoutMs: settings.eval.timeoutSeconds * 1000,
    gate(trigger: Trigger, thread, tickets) {
      if (!trigger.human) return machineGate(trigger)
      const allowed = allowedSender(settings, trigger.actor)
      const scope = listened(sources, trigger.source, trigger.meta)
      const row = scope.listened ? scope.row : undefined
      const recorded = { source: trigger.source, scope: trigger.meta, ...row === undefined ? {} : { row }, ...allowed ? { sender: senderName(allowed) } : {} }
      if (allowed && trigger.addressed) return { admissible: true, strength: 'explicit', basis: { ...recorded, via: 'addressed', addressed: trigger.addressed } }
      const cell = admissionCell(!!allowed, !!trigger.addressed)!
      // Unaddressed messages only use the admission table when the Source observes all messages in that scope.
      const receivable = !!trigger.addressed || (scope.listened && scope.observed)
      const admission = receivable ? admissionOf(settings, trigger.source, row, cell) : 'ignore'
      const basis = { ...recorded, via: 'admission' as const, cell, ...trigger.addressed ? { addressed: trigger.addressed } : {} }
      // Check explicit admission cells before thread follow-ups so a thread's tickets never weaken an explicit request to a follow-up.
      if (admission === 'explicit') return { admissible: true, strength: 'explicit', basis }
      // Direct-message threads belong to one sender (no follow-up for others), and inferred follow-ups require an accept mode other than off (when off, the table decides).
      if (!(trigger.addressed === 'direct' && !allowed) && (allowed || mode !== 'off') && participating(thread, tickets)) {
        return { admissible: true, strength: allowed ? 'explicit' : 'inferred', basis: { ...recorded, via: 'followup' } }
      }
      if (admission === 'inferred' && mode !== 'off') return { admissible: true, strength: 'inferred', basis: { ...basis, observation: { mode } } }
      return { admissible: false, reason: !allowed ? 'not_a_member' : receivable && admission === 'ignore' ? 'admission_ignored' : 'no_mention' }
    },
    admitsInferred: rules => mode === 'auto' && rules.length > 0 && rules.every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id)),
    revalidate(mandate: Mandate) {
      // Revalidation rules follow docs/002 (Eval path; Resume revalidates).
      const { basis } = mandate
      const { source } = basis
      const current = source && basis.scope ? listened(sources, source, basis.scope) : undefined
      if (current && !current.listened) return false
      const rulesOn = (rules: string[] | undefined) => (rules ?? []).every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id))
      // Explicit follow-ups remain valid; inferred follow-ups require auto mode and enabled matched rules.
      if (basis.via === 'followup') return mandate.strength === 'explicit' || (mode === 'auto' && rulesOn(basis.rules))
      // Internal accepts — a project Lead's decision, or the main Session acting on an installation automation delivery —
      // came from no Source message, so no Source check or observation mode applies (docs/012 D2, D12).
      if (basis.via === 'lead' || basis.via === 'installation' || basis.via === 'escalation') return true
      // A bot's candidate holds only while the bot remains on its Source's bot list and passes the observation checks below.
      if (basis.via === 'bot' && !listedBot(settings, mandate.actor)) return false
      // An admission-table Mandate holds while the sender's current cell still grants at least the original strength.
      if (basis.via === 'admission') {
        const { cell } = basis
        const listed = !!allowedSender(settings, mandate.actor)
        // A listed sender who addresses the agent is always explicit and uses no table cell.
        if (cell === 'unlistedAddressed' && listed) return true
        // A sender added to the allowed list since acceptance moves to the listed cell, and still undergoes observation checks below.
        const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
        if (now === 'listedUnaddressed' && !listed) return false
        const admission = admissionOf(settings, source ?? '', current?.listened ? current.row : undefined, now)
        if (STRENGTH[admission] < STRENGTH[mandate.strength]) return false
        if (mandate.strength === 'explicit') return true
      } else if (basis.via !== 'bot' && !allowedSender(settings, mandate.actor)) return false
      // Observed/inferred Mandates hold only while auto mode is active and all matched rules remain enabled.
      if ((basis.via === 'admission' || basis.via === 'listed' || basis.via === 'bot') && basis.observation) return mode === 'auto' && rulesOn(basis.rules)
      return true
    },
  }
}
