/** Block-scoped settings validation, optimistic concurrency saves, settings proposals, processing pause control, and source policy synchronization. */
import type { Context } from '@deepseek-ai/cordis'
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { UserError, type EngineForSettings } from '../core/index.ts'
import { EvalConfigSchema, ExecutorConfigSchema, LanguageConfigSchema, MemoryConfigSchema, PolicyConfigSchema, SettingsSchema, WorkspaceConfigSchema, fieldTier, policyEffects, policyVersion } from '../policy.ts'
import type { Settings as SettingsValue, SettingsBlock, SettingsOrigin, SettingsSave } from '../policy.ts'
import type { SourceHost } from '../sources/host.ts'
import type { HealthBoard, HealthEntry } from '../infra/health.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { resolveRoleModel } from './role-models.ts'
import { changedPaths, settingsNotice } from './notices.ts'
import type { Sessions } from './sessions.ts'
import { setupChanged, type Setup } from './setup.ts'
import type { Store } from './store.ts'
import type { Proposal } from './store.ts'
import { KV } from '../kv.ts'

/**
 * Indicates an optimistic concurrency conflict when saving or syncing a settings block against a stale revision.
 * Thrown by `Settings.save` and `Settings.sync` and translated into an HTTP 409 response by the management routes.
 */
export class SettingsConflict extends Error {}
/**
 * Indicates that a requested settings revision, or a block within it, is not retained, so it cannot be restored.
 * Thrown by `Settings.restore` and translated into an HTTP 404 response by the management routes.
 */
export class SettingsRevisionNotFound extends Error {}
/** Who requested a save and the operator's words that asked for it, recorded with the new revision (docs/011 A5.3). */
export interface SettingsAudit {
  actor?: string; reason?: string; proposal?: string
  /** The earlier revision a restore took this block from; recorded on the new revision and its history row (docs/011 A5.3). */
  restore?: { block: SettingsBlock; from: number }
}
/** Seven days after it was requested, a pending settings proposal stops being actionable (docs/011 A5.2). */
const PROPOSAL_TTL = 7 * 24 * 60 * 60 * 1000
/** Pending settings proposals as the panel and `orchestrator_read settings/proposals` list them, newest first. */
export type ProposalsView = { items: Proposal[] }
/** Reads one dot-separated path from a settings value, for the per-field diff a proposal shows. */
function readPath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => current !== null && typeof current === 'object'
    ? (current as Record<string, unknown>)[key] : undefined, value)
}
const now = (): string => new Date().toISOString()
/** Executor settings that control shell execution paths, prepare commands, command shims, and the registered projects. */
const environment = ({ executor }: SettingsValue) => JSON.stringify([executor.directory, executor.prepare, executor.blockedCommands,
  executor.projects])

/** Schema parser, settings merger, and non-panel origin guard for one settings block kind. */
interface Block {
  parse(value: unknown, sources: SourceRegistry, id: string): unknown
  merge(settings: SettingsValue, value: unknown, id: string): SettingsValue
  guard?(current: SettingsValue, candidate: SettingsValue, origin: SettingsOrigin): void
}
const BLOCKS: Record<'policy' | 'eval' | 'executor' | 'memory' | 'language' | 'workspace' | 'source', Block> = {
  policy: {
    parse: (value, sources) => {
      const policy = PolicyConfigSchema.parse(value)
      return { ...policy, sources: sources.validatePolicy(policy.sources) }
    },
    merge: (settings, value) => ({ ...settings, policy: value as SettingsValue['policy'] }),
  },
  eval: { parse: value => EvalConfigSchema.parse(value), merge: (settings, value) => ({ ...settings, eval: value as SettingsValue['eval'] }) },
  executor: {
    parse: value => ExecutorConfigSchema.parse(value),
    merge: (settings, value) => ({ ...settings, executor: value as SettingsValue['executor'] }),
    // Only the management panel may modify shell execution paths or commands.
    guard: (current, candidate, origin) => { if (origin !== 'panel' && environment(current) !== environment(candidate)) throw new UserError('panelOnlyEnvironment') },
  },
  memory: {
    parse: value => MemoryConfigSchema.parse(value),
    merge: (settings, value) => ({ ...settings, memory: value as SettingsValue['memory'] }),
    // Memory behavior is operator configuration; a tool Session must not switch remembering or injection off.
    guard: (current, candidate, origin) => {
      if (origin !== 'panel' && JSON.stringify(current.memory) !== JSON.stringify(candidate.memory)) throw new UserError('panelOnlyMemory')
    },
  },
  language: {
    parse: value => LanguageConfigSchema.parse(value),
    merge: (settings, value) => ({ ...settings, language: value as SettingsValue['language'] }),
    // The default language is operator configuration; a tool Session must not change what people read.
    guard: (current, candidate, origin) => {
      if (origin !== 'panel' && JSON.stringify(current.language) !== JSON.stringify(candidate.language)) throw new UserError('panelOnlyLanguage')
    },
  },
  workspace: {
    // The path itself is validated and canonicalized by `Setup.verifyWorkspace` in `save`; this schema only keeps the shape.
    parse: value => WorkspaceConfigSchema.parse(value),
    merge: (settings, value) => ({ ...settings, workspace: value as SettingsValue['workspace'] }),
  },
  source: {
    parse: (value, sources, id) => sources.validate(id, z.object({ enabled: z.boolean(), config: z.unknown() }).parse(value)),
    merge: (settings, value, id) => ({ ...settings, sources: { ...settings.sources, [id]: value as SettingsValue['sources'][string] } }),
    // Only the management panel may switch source accounts.
    guard: (current, candidate, origin) => { if (origin !== 'panel' && setupChanged(current, candidate)) throw new UserError('panelOnlyAccounts') },
  },
}

/** Current settings with a Source's config re-validated against the current schema, so a retired key it drops is not a change. */
function normalized(block: SettingsBlock, id: string, current: SettingsValue, sources: SourceRegistry): SettingsValue {
  if (!block.startsWith('source:')) return current
  return {
    ...current,
    sources: { ...current.sources,
      [id]: sources.validate(id, { enabled: current.sources[id]?.enabled ?? true, config: current.sources[id]?.config ?? {} }) },
  }
}

/**
 * Refuses a tool-origin save that touches any field outside tier A (docs/011 A5.5). Confirmation-tier fields name
 * themselves so the model can ask the operator to save them in the panel; panel-only fields keep their existing code.
 * A Source is compared after validation, so dropping a retired config key is not a change the tool has to ask for.
 */
function refuseToolFields(block: SettingsBlock, id: string, current: SettingsValue, candidate: SettingsValue, sources: SourceRegistry): void {
  const changed = changedPaths(normalized(block, id, current, sources), candidate)
  const confirmation = changed.filter(path => fieldTier(block, path) === 'B')
  if (confirmation.length) throw new UserError('approvalRequired', { block, fields: confirmation.join(', ') })
  if (changed.some(path => fieldTier(block, path) === 'C')) {
    throw new UserError(block.startsWith('source:') ? 'panelOnlyAccounts' : 'panelOnlyEnvironment')
  }
}

/** Host dependencies used by `Settings`. */
export interface SettingsHost {
  readonly store: Pick<Store, 'settings' | 'saveSettings' | 'blockRevision' | 'settingsVersion' | 'atomic' | 'tickets' | 'get' | 'proposals'>
  readonly sources: SourceRegistry
  /** Notified when a settings save changes the policy version. */
  readonly engine: EngineForSettings
  /** Health board where each source's policy sync reports under `sync:<id>`. */
  readonly health: Pick<HealthBoard, 'claim'>
  /** DSH Cordis context used to validate and resolve role models. */
  readonly context: Context
  readonly lifetime: AbortSignal
  /** Session manager through which the main Session is notified of saved settings. */
  readonly sessions: Pick<Sessions, 'notify' | 'delivery'>
  /** Source host passed to source kinds' policy syncs and label refreshes. */
  readonly sourceHost: SourceHost
  /** Setup state, account/command checks, workspace validation, and restart trigger when setup-read fields change. */
  readonly setup: Pick<Setup, 'configured' | 'checkAccounts' | 'blockCommands' | 'restart' | 'verifyWorkspace'>
  /** Triggers an immediate pass so work newly allowed by a settings save runs right away. */
  requestPass(): void
}

/**
 * Validates and persists block-scoped settings in `Store`, enforces origin guards, and manages source policy synchronization and label refreshes.
 * `Runtime`, management HTTP routes, and main-Session tools read and save settings through it.
 * Notifies `Engine` when the policy version changes, notifies the main Session via `Sessions`, and triggers `Setup` restarts or `Passes` runs when saved settings take effect.
 * Tracks per-source synchronization status in `HealthBoard` and retries failed syncs with exponential backoff.
 */
export class Settings {
  /** Per-source `sync:<id>` health entries, claimed lazily on each source's first policy sync. */
  private readonly syncs = new Map<string, HealthEntry>()
  /** Pending exponential-backoff retry timer and last wait duration (ms) per source after a failed sync. */
  private readonly retries = new Map<string, { timer: ReturnType<typeof setTimeout>; wait: number }>()
  constructor(private readonly host: SettingsHost) {
    host.lifetime.addEventListener('abort', () => { for (const { timer } of this.retries.values()) clearTimeout(timer) }, { once: true })
  }
  /** Schedule exponential backoff retries (1 minute up to 1 hour) after a failed source sync, or clear pending retries on success. */
  private retrySync(id: string, failed: boolean): void {
    const previous = this.retries.get(id)
    if (previous) clearTimeout(previous.timer)
    this.retries.delete(id)
    if (!failed || this.host.lifetime.aborted) return
    const wait = previous ? Math.min(previous.wait * 2, 3_600_000) : 60_000
    const timer = setTimeout(() => { this.sync(id).catch(() => { /* sync() records its failure in health. */ }) }, wait)
    timer.unref?.()
    this.retries.set(id, { timer, wait })
  }
  private syncHealth(id: string): HealthEntry {
    let entry = this.syncs.get(id)
    if (!entry) this.syncs.set(id, entry = this.host.health.claim(`sync:${id}`))
    return entry
  }
  /** Returns the current validated settings from `Store`. */
  current(): SettingsValue { return this.host.store.settings() }
  /**
   * Returns an overview of all settings blocks with their current block revisions: full values for `pause`, `eval`, and
   * `executor`; rule summaries and allowed-sender counts for `policy`; and instance status switches for `sources` (with `read: 'settings/<block>'` paths for full block reads).
   */
  view() {
    const { store, sources } = this.host
    const settings = store.settings(), revision = (block: SettingsSave) => store.blockRevision(block)
    const { rules, sources: parts } = settings.policy
    return { revision: store.get(KV.settings.revision) ?? 0,
      pause: { revision: revision('pause'), value: { paused: settings.paused } },
      eval: { revision: revision('eval'), value: settings.eval },
      executor: { revision: revision('executor'), value: settings.executor },
      memory: { revision: revision('memory'), value: settings.memory },
      language: { revision: revision('language'), value: settings.language },
      workspace: { revision: revision('workspace'), value: settings.workspace },
      policy: { revision: revision('policy'), rules: rules.map(rule => ({ id: rule.id, name: rule.name, enabled: rule.enabled })),
        allowed: Object.fromEntries(Object.entries(parts).map(([id, part]) => [id, part.allowed.length])), read: 'settings/policy' },
      sources: sources.instances(settings).map(({ id, kind, enabled, installed }) =>
        ({ id, kind, enabled, installed, revision: revision(`source:${id}`), read: `settings/source:${id}` })) }
  }
  /**
   * Returns one settings block as accepted by `save` (`policy`, `eval`, `executor`, `pause` holding `{ paused }`, or
   * `source:<id>` holding `{ enabled, config }`) along with its current block revision.
   * @throws UserError (`unknownBlock`) when no such settings block exists.
   */
  block(block: string): { block: string; revision: number; value: unknown } {
    const { store, sources } = this.host
    const settings = store.settings(), id = block.startsWith('source:') ? block.slice('source:'.length) : undefined
    const instance = id === undefined ? undefined : sources.instances(settings).find(item => item.id === id)
    const value = block === 'pause' ? { paused: settings.paused } : block === 'policy' || block === 'eval' || block === 'executor'
      || block === 'memory' || block === 'language' || block === 'workspace' ? settings[block]
      : instance ? { enabled: instance.enabled, config: instance.config } : undefined
    if (value === undefined) throw new UserError('unknownBlock', { block })
    return { block, revision: store.blockRevision(block as SettingsSave), value }
  }
  /**
   * Restores one settings block to the value it held in a saved revision, as a new revision through the ordinary panel save
   * path (docs/011 A5.3). Every guard still runs: a setup field is checked and restarts the application, Policy effects are
   * applied, and tier-C fields are accepted only because this is a panel-origin save. The new revision records
   * `restoredFrom`, and the settings history is the audit trail; there is no separate audit table.
   * @param revision - A retained settings revision, as `GET policy/history` lists the newest 30; the API accepts any retained one.
   * @param audit - The Session that asked for the restore and the operator's words that asked for it, when any.
   * @returns The ordinary save outcome plus `restoredFrom`.
   * @throws SettingsRevisionNotFound when the revision, or that block's value in it, is not retained.
   * @throws SettingsConflict when the block already has that value (a restore always saves a new revision) or changed meanwhile.
   * @throws UserError when the block is unknown, the Source is not installed, or a save guard refuses the value.
   */
  async restore(block: SettingsBlock, revision: number, audit: Pick<SettingsAudit, 'actor' | 'reason'> = {}) {
    const { store, sources } = this.host
    const id = block.startsWith('source:') ? block.slice('source:'.length) : block
    const kind = block.startsWith('source:') ? 'source' : block
    if (!(kind in BLOCKS)) throw new UserError('unknownBlock', { block })
    if (kind === 'source' && !sources.kind(id)) throw new UserError('sourceNotInstalled', { source: id })
    const snapshot = store.settingsVersion(revision)
    if (snapshot === undefined) throw new SettingsRevisionNotFound(`No settings revision ${revision} is retained`)
    const stored = kind === 'source' ? snapshot.settings.sources[id] : undefined
    const value = kind === 'source'
      ? stored === undefined ? undefined : { enabled: stored.enabled, config: stored.config }
      : snapshot.settings[block as 'policy' | 'eval' | 'executor' | 'memory' | 'language' | 'workspace']
    if (value === undefined) throw new SettingsRevisionNotFound(`Settings revision ${revision} does not contain ${block}`)
    const saved = await this.save(block, value, store.blockRevision(block), 'panel',
      { ...audit, restore: { block, from: revision } })
    return { ...saved, restoredFrom: revision }
  }
  /**
   * Records a tier-B settings proposal for the operator's approval in the management panel (docs/011 A5.2). The value is
   * validated against the block's current schema and diffed against current settings, so the proposal lists only fields it
   * changes and the panel can show each old and new value. A tool may propose only while it changes at least one tier-B
   * field; a tier-A-only change is refused because the tool may save it directly, and a panel-only field keeps its code.
   * A new proposal supersedes every older pending proposal for the same block.
   * @param reason - The operator's words that asked for the change, recorded with the proposal and on the revision that
   * applying it saves.
   * @param actor - The Session that requested the proposal.
   */
  propose(block: SettingsBlock, value: unknown, reason: string, actor: string): Proposal {
    const { store, sources } = this.host
    const text = reason.trim()
    if (!text) throw new UserError('reasonRequired')
    if (text.length > 280) throw new Error('A settings proposal reason may be at most 280 characters')
    if ((block as string) === 'pause') throw new Error('Pause is a tier-A setting: save it directly with orchestrator_settings_save')
    const id = block.startsWith('source:') ? block.slice(7) : block
    const kind = block.startsWith('source:') ? 'source' : block
    if (!(kind in BLOCKS)) throw new UserError('unknownBlock', { block })
    if (kind === 'source' && !sources.kind(id)) throw new UserError('sourceNotInstalled', { source: id })
    const rules = BLOCKS[kind as keyof typeof BLOCKS]
    const parsed = rules.parse(value, sources, id)
    const current = store.settings()
    const candidate = rules.merge(current, parsed, id)
    const changed = changedPaths(normalized(block, id, current, sources), candidate)
    if (!changed.length) throw new Error('The proposed settings value changes nothing')
    const tiers = changed.map(path => fieldTier(block, path))
    if (tiers.includes('C')) throw new UserError(block.startsWith('source:') ? 'panelOnlyAccounts' : 'panelOnlyEnvironment')
    if (!tiers.includes('B')) {
      throw new Error(`These settings can be saved directly with orchestrator_settings_save: ${changed.join(', ')}`)
    }
    const at = now()
    const created = Date.now()
    const proposal: Proposal = { id: `pr-${randomBytes(4).toString('hex')}`, block, base_revision: store.blockRevision(block),
      value: parsed, diff: changed.map(path => ({ path, from: readPath(current, path), to: readPath(candidate, path) })),
      reason: text, actor, status: 'pending', created_at: new Date(created).toISOString(),
      expires_at: new Date(created + PROPOSAL_TTL).toISOString() }
    store.atomic(() => {
      for (const older of store.proposals.pending(block)) store.proposals.save({ ...older, status: 'superseded', decided_at: at })
      store.proposals.save(proposal)
    })
    return proposal
  }
  /**
   * Pending settings proposals, newest first. A pending proposal older than seven days is recorded expired as it is read,
   * so an ignored proposal stops being actionable without a background job.
   */
  proposals(): ProposalsView {
    const items = this.host.store.proposals.pending().map(proposal => this.expire(proposal))
    return { items: items.filter(proposal => proposal.status === 'pending') }
  }
  /** One settings proposal in any state, or undefined; a pending past-expiry proposal is recorded expired when read. */
  proposal(id: string): Proposal | undefined {
    const proposal = this.host.store.proposals.get(id)
    return proposal === undefined ? undefined : this.expire(proposal)
  }
  private expire(proposal: Proposal): Proposal {
    if (proposal.status !== 'pending' || Date.parse(proposal.expires_at) > Date.now()) return proposal
    const expired: Proposal = { ...proposal, status: 'expired', decided_at: now() }
    this.host.store.proposals.save(expired)
    return expired
  }
  /**
   * Applies a pending proposal through the ordinary panel save path, so validation guards, model checks, policy effects,
   * notifications, and restarts behave exactly as if the operator had saved the block. The new revision records the
   * proposal's actor and reason and the proposal id (docs/011 A5.3).
   * @returns The saved revision and the applied proposal, or undefined when no proposal has that id.
   * @throws SettingsConflict when the proposal is no longer pending or its base revision moved; a failed save is recorded
   * on the proposal as `error` and leaves it pending for a retry.
   */
  async applyProposal(id: string): Promise<{ revision: number; restarting: boolean; proposal: Proposal } | undefined> {
    const { store } = this.host
    const pending = this.proposal(id)
    if (pending === undefined) return undefined
    if (pending.status !== 'pending') throw new SettingsConflict(`Settings proposal ${id} is ${pending.status}, not pending`)
    const block = pending.block
    if (block === 'pause') {
      store.proposals.save({ ...pending, status: 'expired', decided_at: now() })
      throw new SettingsConflict('Pause is a tier-A setting: save it directly with orchestrator_settings_save')
    }
    if (pending.base_revision !== store.blockRevision(block)) {
      store.proposals.save({ ...pending, status: 'expired', decided_at: now() })
      throw new SettingsConflict('Settings changed. Reload before saving.')
    }
    try {
      const saved = await this.save(block, pending.value, pending.base_revision, 'panel',
        { actor: pending.actor, reason: pending.reason, proposal: pending.id })
      const proposal: Proposal = { ...pending, status: 'applied', decided_at: now(), decided_by: 'panel', applied_revision: saved.revision }
      store.proposals.save(proposal)
      return { revision: saved.revision, restarting: saved.restarting, proposal }
    } catch (error) {
      store.proposals.save({ ...pending, error: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
  /**
   * Rejects a pending proposal without touching settings.
   * @returns The rejected proposal, or undefined when no proposal has that id.
   * @throws SettingsConflict when the proposal is no longer pending (already applied, rejected, superseded, or expired).
   */
  rejectProposal(id: string): Proposal | undefined {
    const pending = this.proposal(id)
    if (pending === undefined) return undefined
    if (pending.status !== 'pending') throw new SettingsConflict(`Settings proposal ${id} is ${pending.status}, not pending`)
    const proposal: Proposal = { ...pending, status: 'rejected', decided_at: now(), decided_by: 'panel' }
    this.host.store.proposals.save(proposal)
    return proposal
  }
  /**
   * Validates and saves one settings block against its `revision`; a no-op save records no new revision, a changed policy
   * version notifies affected open tickets, and changing a setup-read field (`SETUP_FIELDS`, such as an account CLI) or any
   * change saved while waiting for setup (`!this.host.setup.configured()`) restarts `dsh-superagent-further` so setup runs again.
   * @param origin - Caller origin; restricts execution-environment and account-CLI changes to `'panel'` (a guardrail against prompt-injected tool calls, not an OS security boundary, since agents run shell commands; `origin` has no default so no caller receives panel privileges implicitly).
   * @param audit - `actor` and the operator's `reason` for a save; a `'tool'` origin must give a non-empty reason, and both are recorded on the new revision.
   * @returns Save outcome with the block's current `revision`, whether `policy_changed`, whether `restarting`, and `context_delivery` status (`'injected'` or `'pending'`).
   * @throws SettingsConflict when `block`'s revision changed before or during validation checks.
   * @throws UserError | z.ZodError when `block` is unknown, the source is not installed, `value` is invalid (such as an `executor` block carrying `paused`, which only `pause` sets), a tool save lacks a reason or changes a field outside tier A (docs/011), a non-panel `origin` changes panel-only fields, or a role-model or account check fails.
   */
  async save(block: SettingsBlock, value: unknown, revision: number, origin: SettingsOrigin, audit: SettingsAudit = {}) {
    const { store, sources, engine, sessions } = this.host
    if (origin === 'tool' && !audit.reason?.trim()) throw new UserError('reasonRequired')
    const stale = () => revision !== store.blockRevision(block)
    if (stale()) throw new SettingsConflict('Settings changed. Reload before saving.')
    const id = block.startsWith('source:') ? block.slice(7) : block
    const kind = block.startsWith('source:') ? 'source' : block
    if (!(kind in BLOCKS)) throw new UserError('unknownBlock', { block })
    if (audit.restore && audit.restore.block !== block) throw new Error('A restore audit must name the block being saved')
    const rules = BLOCKS[kind as keyof typeof BLOCKS]
    if (kind === 'source' && !sources.kind(id)) throw new UserError('sourceNotInstalled', { source: id })
    const parsed = rules.parse(value, sources, id)
    const current = store.settings()
    // A workspace save is validated and canonicalized by the same rules startup enforces, so a stored path is always the
    // canonical directory DSH registers and the master session derives its identity from.
    if (kind === 'workspace') (parsed as SettingsValue['workspace']).path = await this.host.setup.verifyWorkspace((parsed as SettingsValue['workspace']).path, current)
    const candidate = rules.merge(current, parsed, id)
    if (origin === 'tool') refuseToolFields(block, id, current, candidate, sources)
    const model = block === 'eval' ? candidate.eval.model : block === 'executor' ? candidate.executor.model : null
    const previous = block === 'eval' ? current.eval.model : block === 'executor' ? current.executor.model : null
    if (model && JSON.stringify(model) !== JSON.stringify(previous)) {
      try { await resolveRoleModel(this.host.context, model) }
      catch (error) { throw new UserError('modelUnavailable', { block, error: error instanceof Error ? error.message : String(error) }) }
    }
    rules.guard?.(current, candidate, origin)
    if (setupChanged(current, candidate)) await this.host.setup.checkAccounts(block, candidate)
    if (stale()) throw new SettingsConflict('Settings changed during the checks. Reload before saving.')
    // Re-read current settings after async checks in case unrelated blocks were saved concurrently.
    const old = store.settings()
    const settings = rules.merge(old, parsed, id)
    if (JSON.stringify(SettingsSchema.parse(settings)) === JSON.stringify(old)) {
      // A restore always creates a revision so the history records where it came from; restoring the current value is a conflict.
      if (audit.restore) throw new SettingsConflict(`Settings already match revision ${audit.restore.from}; nothing to restore`)
      const delivery = await sessions.delivery(`settings:${block}`)
      return { saved: true, revision: store.blockRevision(block), policy_changed: false, restarting: false, context_delivery: delivery }
    }
    const restarting = setupChanged(old, settings) || !this.host.setup.configured()
    const before = policyVersion(old), after = policyVersion(settings)
    const scope = (version: SettingsValue) => ({
      scope: (input: { source: string; meta: Record<string, unknown> }) => this.host.sources.scope(input, version) })
    const effects = before === after ? new Map() : policyEffects(store.tickets.open(), old, SettingsSchema.parse(settings), scope)
    const notified = [...effects.keys()]
    store.atomic(() => {
      store.saveSettings(SettingsSchema.parse(settings), { source: origin, block, policyVersion: after, policyChanged: before !== after, notified,
        ...(audit.actor === undefined ? {} : { actor: audit.actor }), ...(audit.reason === undefined ? {} : { reason: audit.reason }),
        ...(audit.proposal === undefined ? {} : { proposal: audit.proposal }),
        ...(audit.restore === undefined ? {} : { restoredFrom: audit.restore.from }) })
      if (origin !== 'tool') sessions.notify(...settingsNotice(block, changedPaths(old, settings)))
      if (before !== after) engine.policyChanged(before, after, effects)
    })
    // Rewrite worker command shims immediately when `blockedCommands` changes.
    const blocked = settings.executor.blockedCommands
    const changed = blocked.join(' ') !== old.executor.blockedCommands.join(' ')
    if (changed) await this.host.setup.blockCommands(blocked)
    // When restarting, the notice stays pending until after the restart; `setup.restart()` defers until this call returns.
    const delivery = restarting ? 'pending' : await sessions.delivery(`settings:${block}`)
    if (restarting) this.host.setup.restart()
    else this.host.requestPass()
    return { saved: true, revision: store.blockRevision(block), policy_changed: before !== after, restarting, context_delivery: delivery }
  }
  /**
   * Pauses or resumes processing (new evaluations, worker dispatch, and channel delivery, while Sources continue recording
   * Triggers); saved in its own `'pause'` block so concurrent `executor` edits remain valid across it.
   * @param audit - `actor` and the operator's `reason`; a `'tool'` origin must give a non-empty reason.
   * @returns Whether processing is now paused (`{ paused }`).
   */
  async pause(paused: boolean, origin: SettingsOrigin, audit: SettingsAudit = {}): Promise<{ paused: boolean }> {
    const { store, sessions } = this.host
    if (origin === 'tool' && !audit.reason?.trim()) throw new UserError('reasonRequired')
    const old = store.settings()
    if (old.paused === paused) return { paused }
    store.atomic(() => {
      const record = { source: origin, block: 'pause' as const, policyVersion: policyVersion(old), policyChanged: false, notified: [],
        ...(audit.actor === undefined ? {} : { actor: audit.actor }), ...(audit.reason === undefined ? {} : { reason: audit.reason }) }
      store.saveSettings({ ...old, paused }, record)
      if (origin !== 'tool') sessions.notify(...settingsNotice('pause', ['paused']))
    })
    await sessions.delivery('settings:pause')
    this.host.requestPass()
    return { paused }
  }
  /** Returns the IDs of installed, enabled Sources whose policy section can synchronize now (empty while setup is not configured). */
  syncable(): string[] {
    const { sources } = this.host
    if (!this.host.setup.configured()) return []
    return sources.instances().filter(instance => instance.installed && instance.enabled).flatMap(instance => {
      const sync = sources.kind(instance.id)?.policy?.sync
      const part = sources.policyPart(instance.id)
      return sync && part && sync.ready(part) ? [instance.id] : []
    })
  }
  /**
   * Synchronizes source `id`'s policy section from its external source of truth, saves it as a `'policy'` revision when
   * changed, and records the outcome in the `sync:<id>` health entry (scheduling exponential-backoff retries via `retrySync` on failure).
   * @returns The synchronized policy section for `id`.
   * @throws UserError (`nothingToSync`) when `id` cannot sync now, `SettingsConflict` if the `'policy'` block changed during synchronization, or the underlying sync error on failure.
   */
  async sync(id: string) {
    const { store, sources } = this.host
    if (!this.syncable().includes(id)) throw new UserError('nothingToSync', { source: id })
    const health = this.syncHealth(id)
    try {
      const revision = store.blockRevision('policy')
      const part = await sources.kind(id)!.policy!.sync!.run(this.host.sourceHost, sources.policyPart(id)!, this.host.lifetime)
      if (revision !== store.blockRevision('policy')) throw new SettingsConflict('Policy changed during synchronization. Retry with the current settings.')
      const policy = store.settings().policy
      // Skip saving a new revision when the synced list is unchanged.
      if (JSON.stringify(part) !== JSON.stringify(policy.sources[id])) {
        await this.save('policy', { ...policy, sources: { ...policy.sources, [id]: part } }, revision, 'sync')
      }
      health.set({ state: 'ready', detail: `${part.allowed.length} allowed`, at: now() })
      this.retrySync(id, false)
      return part
    } catch (error) {
      health.set({ state: 'error', detail: String(error), at: now() })
      this.retrySync(id, true)
      throw error
    }
  }
  /**
   * Rereads a Source's display names (such as Feishu chat names) immediately.
   * @returns Sorted display names (`{ added }`) that were not present in the stored label map before this read.
   * @throws UserError (`noLabels`) when the Source has no label refresh; rethrows a failed read, keeping the stored list.
   */
  async refreshLabels(id: string): Promise<{ added: string[] }> {
    const { store, sources } = this.host
    const instance = sources.instance(id)
    const kind = instance && sources.kind(instance.kind)
    if (!kind?.refreshLabels) throw new UserError('noLabels')
    const before = store.get(KV.sources.labels(id)) ?? {}
    const after = await kind.refreshLabels(this.host.sourceHost)
    return { added: Object.entries(after).filter(([key]) => !(key in before)).map(([, name]) => name).sort((a, b) => a.localeCompare(b)) }
  }
}
