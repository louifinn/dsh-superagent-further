/** Delivers one existing local file into a Feishu chat as a bot file message. */
import { z } from 'zod'
import type { SourceContext } from './host.ts'
import type { SourceFileRequest, SourceFileResult } from './kind.ts'

/**
 * Send `request.name` from `request.directory` to `request.chatId`. `lark-cli` refuses absolute paths and `..`, so the
 * command runs inside the file's own directory and names only the file; the idempotency key keeps a retry from posting
 * the same file twice.
 */
export async function sendFeishuFile(host: Pick<SourceContext, 'commands' | 'configured'>, request: SourceFileRequest,
  signal?: AbortSignal): Promise<SourceFileResult> {
  if (!host.configured()) throw new Error('The Feishu Source is not configured')
  const args = ['im', '+messages-send', '--chat-id', request.chatId, '--file', request.name]
  if (request.idempotencyKey !== undefined) args.push('--idempotency-key', request.idempotencyKey)
  const data = z.object({ message_id: z.string().min(1) }).parse(await host.commands.withSignal(signal).lark(args, request.directory))
  return { messageId: data.message_id }
}
