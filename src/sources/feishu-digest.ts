/**
 * The Feishu daily digest: one chat-level summary a day of the Tickets that wait for a person.
 *
 * A digest is not a reply, so it cannot use a Channel (those answer a message in its Thread): it posts a
 * new message to the chat the configuration names, with an idempotency key for the day. It needs no history
 * and no Thread, and it reports its own health entry, so a failed send is visible rather than silent.
 */
import { setTimeout as delay } from 'node:timers/promises'
import { ticketStage, type Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { FeishuConfig } from './feishu.ts'
import { SOURCE } from './feishu-trigger.ts'
import type { SourceContext } from './host.ts'

const MINUTE = 60_000
const DAY = 86_400_000
/** How many waiting Tickets a digest lists before it says the rest are in the panel. */
const SHOWN = 8
/** What a Ticket waiting for a person needs, in the two languages the digest may speak. */
const ACTIONS = {
  zh: { delivery: '输入没有送到它手上', answer: '回答它的问题', review: '审阅结果，必要时合并 PR', blocked: '它受阻了，需要你的决定', failed: '它失败了，需要你的决定' },
  en: { delivery: 'an input could not reach its worker', answer: 'answer its question', review: 'review the result, and merge the pull request if it is right', blocked: 'it is blocked and needs your decision', failed: 'it failed and needs your decision' },
} as const
const HAN = /\p{Script=Han}/u
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u
/** Chinese when the text holds Han characters and no kana, like the other outbound notices. */
const chinese = (text: string): boolean => HAN.test(text) && !KANA.test(text)

/** The local calendar day a digest belongs to, as `YYYY-MM-DD`. */
export const digestDay = (now: Date): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

/** The next instant a digest is due at `hour` local time, strictly after `now`. */
export const nextDigest = (hour: number, now: Date): Date => {
  const at = new Date(now)
  at.setHours(hour, 0, 0, 0)
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1)
  return at
}

/** Whole days `at` has waited by `now`; a missing or future instant counts as zero. */
const waitingDays = (at: string | undefined, now: Date): number => {
  const then = at === undefined ? Number.NaN : Date.parse(at)
  return Number.isNaN(then) ? 0 : Math.max(0, Math.floor((now.getTime() - then) / DAY))
}

/** One waiting Ticket's bullet, its waiting time, and its link; shared by the flat and the grouped list. */
const entry = (ticket: Ticket, words: (typeof ACTIONS)['zh'] | (typeof ACTIONS)['en'], now: Date, speakChinese: boolean): string[] => {
  const stage = ticketStage(ticket)
  const action = stage.stage === 'person' ? words[stage.action] : ''
  const days = waitingDays(ticket.updatedAt, now)
  const waited = days === 0 ? '' : speakChinese ? `，已等 ${days} 天` : `, waiting ${days} ${days === 1 ? 'day' : 'days'}`
  const lines = [`· ${ticket.title} — ${action}${waited}`]
  const link = ticket.channels.map(channel => channel.address.url).find(url => typeof url === 'string' && url !== '')
  if (link) lines.push(`  ${link}`)
  return lines
}

/** Waiting Tickets by project id, named projects in id order first and Tickets without one last. */
const byProject = (tickets: readonly Ticket[]): [string, Ticket[]][] => {
  const groups = new Map<string, Ticket[]>()
  for (const ticket of tickets) {
    const id = ticket.project ?? ''
    const group = groups.get(id)
    if (group) group.push(ticket)
    else groups.set(id, [ticket])
  }
  return [...groups.entries()].sort(([left], [right]) => (left === '' ? 1 : right === '' ? -1 : left.localeCompare(right)))
}

/**
 * The digest text for the open Tickets `tickets` at `now`: how many wait for a person, what each needs and
 * how long it has waited, and how many are working. It always says something, so a quiet day is still a
 * daily message; only a waiting Ticket speaks Chinese or English, an empty one says it in both. When any
 * waiting Ticket names a project, the list is grouped under the project names in `names`; otherwise it
 * stays one flat list, exactly as before projects existed.
 */
export const digestText = (tickets: readonly Ticket[], now: Date, names: Readonly<Record<string, string>> = {}): string => {
  const person = tickets.filter(ticket => ticketStage(ticket).stage === 'person')
  const working = tickets.length - person.length
  const speakChinese = person.length === 0
    ? tickets.some(ticket => chinese(ticket.title))
    : person.some(ticket => chinese(ticket.title))
  const words = speakChinese ? ACTIONS.zh : ACTIONS.en
  const lines = [speakChinese ? `每日摘要 · ${digestDay(now)}` : `Daily digest · ${digestDay(now)}`]
  if (person.length === 0) {
    lines.push('今天没有待你处理的工单。Nothing waits for you today.')
  } else {
    lines.push(speakChinese ? `待你处理 ${person.length} 单：` : `${person.length} ${person.length === 1 ? 'Ticket waits' : 'Tickets wait'} for you:`)
    const ordered = person.slice().sort((left, right) => (left.updatedAt ?? '').localeCompare(right.updatedAt ?? ''))
    const grouped = ordered.some(ticket => ticket.project)
    let shown = 0
    if (grouped) {
      for (const [id, group] of byProject(ordered)) {
        if (shown >= SHOWN) break
        lines.push(id === ''
          ? speakChinese ? '未归属项目' : 'No project'
          : speakChinese ? `项目 ${names[id] ?? id}` : `Project ${names[id] ?? id}`)
        for (const ticket of group) {
          if (shown >= SHOWN) break
          lines.push(...entry(ticket, words, now, speakChinese))
          shown += 1
        }
      }
    } else {
      for (const ticket of ordered.slice(0, SHOWN)) {
        lines.push(...entry(ticket, words, now, speakChinese))
        shown += 1
      }
    }
    if (ordered.length > shown) lines.push(speakChinese ? `（其余 ${ordered.length - shown} 单见面板。）` : `(${ordered.length - shown} more are in the panel.)`)
    if (working > 0) lines.push(speakChinese ? `另外 ${working} 单在进行。` : `${working} more ${working === 1 ? 'is' : 'are'} working.`)
  }
  lines.push(speakChinese ? '这条摘要每天一次；工单的实际状态以面板为准。' : 'This summary comes once a day; the panel has the current state.')
  return lines.join('\n')
}

/** What one digest tick did; `off` and `skipped` are not failures. */
export type DigestTick = 'off' | 'skipped' | 'sent' | 'failed'

/**
 * Sends the digest once a day inside the configured hour: `off` when no chat is configured, `skipped` for
 * every other minute and for a day already sent, `sent` after the chat took it, and `failed` (reported on
 * the digest health entry) when the CLI could not send, so the next minute tries again.
 */
export async function digestTick(ctx: SourceContext, now = new Date()): Promise<DigestTick> {
  const config = ctx.config<FeishuConfig>(SOURCE)
  const chat = config?.digestChat ?? ''
  if (!config || chat === '') {
    ctx.report('digest', { state: 'paused', detail: 'The daily digest is off' })
    return 'off'
  }
  const day = digestDay(now)
  const next = nextDigest(config.digestHour, now)
  const nextAt = next.toISOString()
  const last = ctx.state.get(KV.feishu.digest)
  if (now.getHours() !== config.digestHour || last?.day === day) {
    ctx.report('digest', { state: 'ready', detail: `Next digest at ${String(config.digestHour).padStart(2, '0')}:00`, nextAt })
    return 'skipped'
  }
  try {
    const names = Object.fromEntries((ctx.projects ?? []).map(({ id, name }) => [id, name]))
    await ctx.commands.lark(['im', '+messages-send', '--chat-id', chat, '--markdown', '-', '--idempotency-key', `digest-${day}`], undefined, digestText(ctx.tickets.open(), now, names))
    ctx.state.set(KV.feishu.digest, { day, at: now.toISOString() })
    ctx.report('digest', { state: 'ready', detail: 'Sent today', nextAt })
    return 'sent'
  } catch (error) {
    ctx.report('digest', { state: 'error', detail: `The daily digest failed: ${String(error)}`, nextAt })
    return 'failed'
  }
}

/** Waits for the deployment, then checks the digest every minute while the plugin runs. */
export async function runFeishuDigest(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  while (!signal.aborted) {
    if (!ctx.configured() || !ctx.deployment.feishu) {
      ctx.report('digest', { state: 'paused', detail: 'Waiting for the deployment check' })
    } else if (ctx.config<FeishuConfig>(SOURCE)) {
      await digestTick(ctx, new Date())
    } else {
      ctx.report('digest', { state: 'paused', detail: 'The daily digest is off' })
    }
    await delay(MINUTE, undefined, { signal }).catch(() => {})
  }
}
