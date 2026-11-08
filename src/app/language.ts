/** The text that tells a Session which language a person reads (docs/006 "Language"). */
import type { Settings } from '../policy.ts'

/**
 * Writes the operator's default language and the two boundaries around it: a Feishu or GitHub reply follows the message
 * it answers, and repository artifacts keep the repository's language. The operator can change the language on the panel
 * at any time, so Sessions carry this text in the runtime-context snapshot rather than the system prompt.
 */
export function languageContext(settings: Settings): string {
  return `Language for text a person reads: ${settings.language.default}. Write messages, reports, titles and notes in this language. A reply on Feishu or GitHub follows the language of the message it answers. Pull request bodies, commit messages, code comments and file contents keep the repository's established language and conventions; structured fields do not change.`
}
