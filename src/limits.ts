/** Validation bounds shared between host schemas and management panel forms. */
export const LIMITS = {
  ruleName: 100,
  ruleInstruction: 2000,
  evalTimeoutSeconds: { min: 30, max: 600 },
  maxWorkers: { min: 1, max: 16 },
  projectWorkers: { min: 1, max: 16 },
  prepareCommand: 4000,
  languageName: 60,
  promptMaxChars: { min: 1000, max: 1_000_000 },
  admissionContextMaxPages: { min: 1, max: 100 },
  admissionContextTimeoutMs: { min: 1, max: 90_000 },
  projects: 50,
  projectName: 80,
  projectPath: 500,
  projectRepository: 200,
  projectBranch: 200,
  worktreeKeepDays: { min: 0, max: 365 },
  memoryText: 4000,
  memoryTag: 40,
  memoryTags: 8,
  memoryRows: 2000,
  memoryPromptChars: 1200,
  memoryPromptCharsMax: 4000,
  memoryPromptRows: 12,
  memoryPinned: 40,
  memoryKeepDays: { min: 1, max: 3650 },
  automationTitle: 120,
  automationInstruction: 4000,
  automationRule: 2000,
  automationTasks: 20,
  automationAudit: 20,
} as const

// How many delivery records the plugin keeps per automation. It lives here, next to the other automation limits, so modules
// that the client graph can reach (the automation service) do not have to import the SQLite-backed store for one number.
export const AUTOMATION_DELIVERY_LIMIT = 50
