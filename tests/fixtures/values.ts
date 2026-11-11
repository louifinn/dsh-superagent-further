/** The injected DSH values, for the unit suites that exercise a value-taking constructor directly. */
import { Service } from '@deepseek-ai/cordis'
import { freezeMessage, MessageId, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { scopeParentOf } from '@deepseek-ai/dsh-scope'
import schemastery from '@deepseek-ai/schemastery'
import type { RuntimeHostValues } from '../../src/runtime-host.ts'

/** The exact values the supervisor's host builder injects, with no host construction needed. */
export const testValues: RuntimeHostValues = { Service, MessageId, ReasoningEffortId, freezeMessage, scopeParentOf, schemastery }
