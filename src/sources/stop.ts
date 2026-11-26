/**
 * The supervisor asks every Source plugin to stop its timers and loops before it drains the runtime, so a callback cannot
 * reach a Store that is closing (issue #42). The event is a plain Cordis broadcast; plugins with nothing to stop simply do
 * not listen. Named here, next to the plugins, so the supervisor and the Source entries share one spelling.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'dsh-superagent-further/sources-stop': () => void
  }
}

export const SOURCES_STOP_EVENT = 'dsh-superagent-further/sources-stop'
