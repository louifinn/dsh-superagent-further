/** One outbound notice for a Request whose delivery spans several Tickets. */
import { key, type OutboundMessage, type Request, type Ticket } from '../core/index.ts'
import { githubPage, githubThreadRef, SOURCE } from '../sources/github-trigger.ts'

const ZH = { merged: '已合并', closed: '已关闭', completed: '已完成', dropped: '已丢弃', stopped: '已停止', failed: '失败', open: '未结束' } as const

/** The last closed pull request a Ticket followed, if any, with its repository. */
const closedPull = (ticket: Ticket): { number: number; repository: string } | undefined => {
  const follows = (ticket.follows ?? []).filter(item => item.closed)
  const follow = follows.filter(item => item.own).at(-1) ?? follows.at(-1)
  if (!follow) return undefined
  const parsed = githubThreadRef(follow.thread)
  const ref = parsed?.ref ?? follow.thread
  return /^\d+$/.test(ref) ? { number: Number(ref), repository: parsed?.repository ?? '' } : undefined
}

/**
 * Builds one idempotent result notice per non-GitHub Channel of a Request that has ended, naming every Ticket and the pull
 * request it delivered. A Request with several Tickets sends this once, when the Request ends, instead of one notice per
 * Ticket, so a person reads one outcome. Language follows the source request text: Chinese when it contains Han without kana.
 */
export function requestResultNotices(
  request: Request, requestText: string, ticketOf: (id: string) => Ticket | undefined, repository: string,
): OutboundMessage[] {
  const ended = request.ended
  if (!ended) return []
  const tickets = request.ticketIds.flatMap(id => { const ticket = ticketOf(id); return ticket ? [ticket] : [] })
  const chinese = /\p{Script=Han}/u.test(requestText) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(requestText)
  const outcome = ended.outcome
  const spoken = chinese
    ? ({ done: '已完成', partial: '部分完成', stopped: '已停止' } as const)[outcome]
    : ({ done: 'is done', partial: 'is partly done', stopped: 'stopped' } as const)[outcome]
  const head = chinese
    ? `「${request.title}」${spoken}（${tickets.length} 个工单）：`
    : `"${request.title}" ${spoken} (${tickets.length} Tickets):`
  const lines = tickets.map(ticket => {
    const pull = closedPull(ticket)
    const link = pull ? `[PR #${pull.number}](${githubPage(pull.repository || repository, pull.number, true)})` : ticket.title
    const state = ticket.ended?.outcome ?? 'open'
    const words = chinese ? ZH[state as keyof typeof ZH] ?? state : state
    return `- ${ticket.project ?? (chinese ? '部署仓库' : 'deployment')}: ${link} ${words}`.trim()
  })
  const text = [head, ...lines].join('\n')
  return request.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('request-result', request.id, channel.source, JSON.stringify(channel.address)),
    channel, text, kind: 'notice' as const,
  }))
}
