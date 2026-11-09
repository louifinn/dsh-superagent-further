import { describe, expect, it } from 'vitest'
import type { SourceContext } from '../src/sources/host.ts'
import { sendFeishuFile } from '../src/sources/feishu-file.ts'

function fakeHost(reply: unknown, configured = true) {
  const calls: { args: string[]; cwd: string | undefined }[] = []
  const commands = {
    lark: async (args: string[], cwd?: string) => { calls.push({ args, cwd }); return reply },
    withSignal: () => commands,
  }
  const host = { commands, configured: () => configured } as unknown as Pick<SourceContext, 'commands' | 'configured'>
  return { calls, host }
}

describe('Feishu file delivery', () => {
  it('sends a file message to the chat from the file directory, with an idempotency key', async () => {
    const { calls, host } = fakeHost({ message_id: 'om_file_1' })
    const result = await sendFeishuFile(host, { chatId: 'oc_1', directory: 'C:\\work', name: 'decisions.md', idempotencyKey: 'dsh-file-k' })
    expect(result).toEqual({ messageId: 'om_file_1' })
    expect(calls).toEqual([{ args: ['im', '+messages-send', '--chat-id', 'oc_1', '--file', 'decisions.md', '--idempotency-key', 'dsh-file-k'], cwd: 'C:\\work' }])
  })

  it('sends without an idempotency key when none is given', async () => {
    const { calls, host } = fakeHost({ message_id: 'om_file_2' })
    await sendFeishuFile(host, { chatId: 'oc_1', directory: '/tmp', name: 'design.md' })
    expect(calls[0]!.args).toEqual(['im', '+messages-send', '--chat-id', 'oc_1', '--file', 'design.md'])
  })

  it('refuses while the Feishu Source is not configured', async () => {
    const { host } = fakeHost({ message_id: 'om_file_3' }, false)
    await expect(sendFeishuFile(host, { chatId: 'oc_1', directory: '/tmp', name: 'design.md' })).rejects.toThrow('not configured')
  })

  it('reports a reply without a message id as an error', async () => {
    const { host } = fakeHost({ ok: true })
    await expect(sendFeishuFile(host, { chatId: 'oc_1', directory: '/tmp', name: 'design.md' })).rejects.toThrow()
  })
})
