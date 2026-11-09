/** One outbound notice for a Request whose delivery spans several Tickets, and the aggregate report of a project request. */
import { key, type ChannelRef, type OutboundMessage, type ProjectRequest, type ProjectRequestStatus, type Request, type Ticket, type Trigger }
  from '../core/index.ts'
import { githubPage, githubThreadRef, SOURCE } from '../sources/github-trigger.ts'

const ZH = { merged: '已合并', closed: '已关闭', completed: '已完成', dropped: '已丢弃', stopped: '已停止', failed: '失败', open: '未结束' } as const
/** A derived project request's status in the Chinese report. */
const STATUS_ZH: Record<ProjectRequestStatus, string> = {
  pending: '待处理', 'needs-info': '待补充', accepted: '已接受', rejected: '已拒绝', 'awaiting-approval': '待批准',
  approved: '已批准', completed: '已完成', withdrawn: '已撤回',
}

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
  const lines = tickets.map(ticket => ticketLine(ticket, chinese, repository))
  const text = [head, ...lines].join('\n')
  return request.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('request-result', request.id, channel.source, JSON.stringify(channel.address)),
    channel, text, kind: 'notice' as const,
  }))
}

/** One report line naming a Ticket, the pull request it delivered, and its outcome. */
function ticketLine(ticket: Ticket, chinese: boolean, repository: string): string {
  const pull = closedPull(ticket)
  const link = pull ? `[PR #${pull.number}](${githubPage(pull.repository || repository, pull.number, true)})` : ticket.title
  const state = ticket.ended?.outcome ?? 'open'
  const words = chinese ? ZH[state as keyof typeof ZH] ?? state : state
  return `- ${ticket.project ?? (chinese ? '部署仓库' : 'deployment')}: ${link} ${words}`.trim()
}

/**
 * The original Channels a project Request's chain started in (docs/012 D6): those of the root's domain Request and the
 * Channel of the Trigger that started it, deduplicated, without GitHub where the Request itself is reported instead.
 */
export function projectResultChannels(
  request: ProjectRequest, requestOf: (id: string) => Request | undefined, triggerOf: (id: string) => Trigger | undefined,
): ChannelRef[] {
  const root = request.root
  if (!root) return []
  const origin = root.request_id ? requestOf(root.request_id) : undefined
  const trigger = root.trigger_id ? triggerOf(root.trigger_id) : undefined
  const seen = new Set<string>()
  return [...(origin?.channels ?? []), ...(trigger?.channel ? [trigger.channel] : [])].filter(channel => {
    if (channel.source === SOURCE) return false
    const id = `${channel.source}:${channel.thread}:${JSON.stringify(channel.address)}`
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/**
 * Builds the one aggregate report of a root project Request (docs/012 D6): one idempotent notice per original Channel,
 * naming every Ticket of the root and its derived requests with its outcome, every derived Request with its status, and the
 * Lead's summary. A root without origin Channels reports nothing; a derived request's own completion is its root's business.
 */
export function projectResultNotices(
  root: ProjectRequest, channels: readonly ChannelRef[], ticketOf: (id: string) => Ticket | undefined,
  requestOf: (id: string) => ProjectRequest | undefined, repository: string,
): OutboundMessage[] {
  if (root.root?.project_request_id) return []
  const derived = root.derived.flatMap(id => { const request = requestOf(id); return request ? [request] : [] })
  const tickets = [...new Set([...root.tickets, ...derived.flatMap(request => request.tickets)])]
    .flatMap(id => { const ticket = ticketOf(id); return ticket ? [ticket] : [] })
  const chinese = /\p{Script=Han}/u.test(root.title + root.instruction) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(root.title + root.instruction)
  const summary = root.replies.at(-1)?.text
  const head = chinese
    ? `项目请求「${root.title}」已完成（${tickets.length} 个工单，${derived.length} 个派生请求）：`
    : `Project request "${root.title}" is complete (${tickets.length} Tickets, ${derived.length} derived requests):`
  const ticketLines = tickets.map(ticket => ticketLine(ticket, chinese, repository))
  const derivedLines = derived.length
    ? [chinese ? '派生请求：' : 'Derived requests:', ...derived.map(request =>
      `- ${request.title}: ${chinese ? STATUS_ZH[request.status] : request.status}`)]
    : []
  const summaryLine = summary ? [chinese ? `总结：${summary}` : `Summary: ${summary}`] : []
  const text = [head, ...ticketLines, ...derivedLines, ...summaryLine].join('\n')
  return channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('project-result', root.id, channel.source, JSON.stringify(channel.address)),
    channel, text, kind: 'notice' as const,
  }))
}
