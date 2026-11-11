/** Component health registry displayed in the overview and source status panels. */
import type { Health } from '../sources/host.ts'

export interface HealthEntry {
  get(): Health | undefined
  set(health: Health): void
  /** Unregisters the entry from the board (such as when a Source kind unregisters); subsequent `set` calls become no-ops. */
  release(): void
}

/** Called after a claim's state changed; a same-state `detail` update does not call it. */
export type HealthTransition = (name: string, previous: Health | undefined, next: Health) => void

/**
 * Central registry of component health entries, enforcing single-writer ownership per entry name.
 * Claimed by Runtime, Effects, Sessions, DshExecutor, Settings, and SourceRegistry, and read by management HTTP routes.
 * An optional transition listener sees only real state changes, so callers can log recovery without detail churn.
 */
export class HealthBoard {
  private readonly entries: Record<string, Health> = {}
  private readonly claimed = new Set<string>()
  constructor(private readonly onChange?: HealthTransition) {}
  claim(name: string, initial?: Health): HealthEntry {
    if (this.claimed.has(name)) throw new Error(`The health entry ${name} is reported by another part`)
    this.claimed.add(name)
    if (initial) this.entries[name] = initial
    let held = true
    return {
      get: () => this.entries[name],
      set: health => {
        if (!held) return
        const previous = this.entries[name]
        this.entries[name] = health
        if (previous?.state !== health.state) this.onChange?.(name, previous, health)
      },
      release: () => {
        if (!held) return
        held = false
        this.claimed.delete(name)
        delete this.entries[name]
      },
    }
  }
  get all(): Readonly<Record<string, Health>> { return this.entries }
}
