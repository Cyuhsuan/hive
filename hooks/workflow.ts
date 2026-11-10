import { githubSource } from './github-source'
import { markdownSource } from './ticket-source'
import type { TicketSource } from './ticket-source'

// A workflow is a set of conventions the person opted into: which skill starts
// the work, where the project says its tickets live, and which ticket source
// that means. `mattpocock-skills` is the only one, and it is built in: nothing
// here is read from the person's settings.

export type SourceChoice =
  | { source: TicketSource; label: string }
  /** The ticket source the setting names is one the workflow cannot read tickets from (yet). */
  | { source?: undefined; label: string; reason: string }

export type Workflow = {
  name: string
  /** Whether a skill the lead invoked starts the work. */
  isStartSkill(skill: string): boolean
  /** Every source the workflow can read tickets from. */
  sources: readonly TicketSource[]
  /** Reads the project's tracker setting, fresh, and picks the ticket source. */
  chooseSource(fs: { read(path: string): Promise<string> }): Promise<SourceChoice>
}

export const TRACKER_FILE = 'docs/agents/issue-tracker.md'

export const mattpocockSkills: Workflow = {
  name: 'mattpocock-skills',
  isStartSkill: skill => /implement-spec$/.test(skill),
  sources: [markdownSource, githubSource],

  async chooseSource(fs) {
    let text: string
    try {
      text = await fs.read(TRACKER_FILE)
    } catch {
      // no tracker file: the local tickets this workflow began with
      return { source: markdownSource, label: markdownSource.label }
    }
    // A file with no title says nothing: it is not read as a local one.
    const title = text.split('\n').find(line => line.trim() !== '')?.trim() ?? ''
    if (/^#\s*Issue tracker:\s*Local Markdown$/i.test(title)) {
      return { source: markdownSource, label: markdownSource.label }
    }
    if (/^#\s*Issue tracker:\s*GitHub$/i.test(title)) {
      return { source: githubSource, label: githubSource.label }
    }
    if (/^#\s*Issue tracker:\s*GitLab$/i.test(title)) {
      return { label: 'GitLab（尚未支援）', reason: '票在 GitLab，尚未支援' }
    }
    return { label: '無法辨識', reason: `${TRACKER_FILE} 的標題無法辨識票來源` }
  },
}

/** The workflow a `workflow` option names; `none` and anything else is none. */
export function workflowOf(name: unknown): Workflow | undefined {
  return name === mattpocockSkills.name ? mattpocockSkills : undefined
}

/** The source a feature was loaded from, among the workflow's and the local default. */
export function sourceById(id: string, workflow: Workflow | undefined): TicketSource {
  return [...(workflow?.sources ?? []), markdownSource].find(s => s.id === id) ?? markdownSource
}
