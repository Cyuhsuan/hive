import type { EngineInterface, Register } from 'claude-code'

import type { Swarm, SwarmAgent } from '../types'
import { PHASE_LABEL, describeCall, isLive, phaseOfCall, whoOf } from './agent-phase'
import { enterWorkflow, loadFeature, openFeature, pickSource, refreshFeature, reportFailure, ticketOfPrompt } from './feature-load'
import { paneModelOf, workflowLine } from './pane-model'
import { drawPane } from './pane-view'
import { EMPTY, PANE, TITLE, isWorkflowShown, log, patchAgent, readSwarm, status, updateSwarm } from './swarm-state'
import { fmtDuration, shortModel, shortType } from './text-format'
import { markdownSource } from './ticket-source'
import { sourceById, workflowOf } from './workflow'
import type { Workflow } from './workflow'

// How often the clock ticks while the pane is up; the tickets are re-read every
// few ticks (a source's `refreshSeconds`).
const TICK_MS = 2000

// The pane is redrawn twice per animation frame, so the feature bar's light glides.
const REDRAW_MS = 60

// ---------------------------------------------------------------- pane

/** Opens the pane at the surface's own width; the person drags it from there. */
async function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: TITLE })
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on, options) => {
  // The setting is read once per load: changing it reloads the module.
  const workflow: Workflow | undefined = workflowOf(options['workflow'])
  const isShown = (s: Swarm) => isWorkflowShown(s, workflow)
  // `off` is the pane as it was before it moved: the same glyphs, drawn at the clock's own pace.
  const isAnimated = options['animation'] !== 'off'

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'swarm',
      description: '打開子代理面板（/swarm reset 清空；/swarm <issues 資料夾>、/swarm #N、/swarm <issue 網址> 載入那批票）',
    })
    // Keep elapsed times moving while anything runs, and re-read the tickets
    // now and then so the feature bar follows what the implementers write.
    let ticks = 0
    $.clock.every(TICK_MS, () => {
      ticks += 1
      void readSwarm($).then(async s => {
        if (s.agents.some(isLive)) $.ui.invalidate('ui.render')
        const target = s.feature ?? s.pending
        if (!target) return
        const every = Math.round((sourceById(target.sourceId, workflow).refreshSeconds * 1000) / TICK_MS)
        // A failed load has no workflow screen yet: it is tried again all the same.
        if (ticks % every === 0 && (!s.feature || isShown(s)) && s.agents.some(isLive)) await refreshFeature($, workflow)
      })
    })

    // The frames: only while a subagent is live and the pane is the one shown.
    if (isAnimated) {
      $.clock.every(REDRAW_MS, () => {
        void readSwarm($).then(async s => {
          if (!s.agents.some(isLive)) return
          const panes = await $.ui.panes()
          if (panes.some(pane => pane.id === PANE && pane.isShown && pane.isPlaced)) $.ui.invalidate('ui.render')
        }).catch(() => undefined)
      })
    }

    return next(e)
  })

  on('command.run', { command: 'swarm' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    if (/^reset\b/.test(args)) {
      await updateSwarm($, () => EMPTY)
      $.ui.status(undefined)
      await pickSource($, workflow)
    } else if (args) {
      if (workflow) {
        const choice = await pickSource($, workflow)
        if (choice?.source) {
          const origin = choice.source.originOfCommand(args)
          if (origin === undefined) await reportFailure($, choice.source, undefined, '要帶 spec issue 的編號或網址')
          else await openFeature($, choice.source, origin, false)
        }
      } else {
        // The one thing `none` still does: the folder the person names.
        const folder = markdownSource.originOfCommand(args)
        if (folder !== undefined) await openFeature($, markdownSource, folder, true)
      }
    } else {
      // Opening the pane reads the setting, not the tickets: those are read at a timing.
      await pickSource($, workflow)
    }
    await status($, workflow)
    await openPane($)

    const s = await readSwarm($)
    const line = workflow ? ` ${workflowLine(workflow, s)}` : ''
    return { text: `Implement swarm pane opened.${line}` }
  })

  // The workflow begins: its start skill was invoked.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    if (e.agentId === undefined && workflow?.isStartSkill(e.skill)) {
      const choice = await pickSource($, workflow)
      if (choice?.source) {
        const at = await $.clock.now()
        const source = choice.source
        await updateSwarm($, s => ({ ...EMPTY, startedAt: at, sourceLabel: s.sourceLabel, sourceId: s.sourceId }))
        await log($, 'lead', `/${e.skill} 開始，等待派票`)
        const origin = source.originOfArgs(e.args ?? '')
        // With no spec named the workflow waits for tickets; with one, it begins when that is read.
        if (origin === undefined || (await loadFeature($, source, origin))) {
          await enterWorkflow($, false)
          await openPane($)
        }
      }
    }

    return next(e)
  }).catch((_$, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.deny !== undefined || started.agentId === undefined) return started

    const at = await $.clock.now()
    const before = await readSwarm($)
    const shown = isShown(before)
    const { ticket, ticketNumber, load } = await ticketOfPrompt($, e.prompt, before, workflow, at, shown)

    const agent: SwarmAgent = {
      id: started.agentId,
      type: e.subagentType,
      description: e.description,
      model: started.model,
      ticket,
      ticketNumber,
      isBackground: e.background,
      phase: 'spawned',
      tools: 0,
      errors: 0,
      startedAt: at,
      parentId: e.parentAgentId,
    }
    await updateSwarm($, s => ({
      ...s,
      startedAt: s.startedAt ?? at,
      leadModel: e.parentAgentId === undefined ? e.parentModel : s.leadModel,
      agents: [...s.agents.filter(a => a.id !== agent.id), agent],
    }))
    await log($, whoOf(agent), `派出 ${shortType(agent.type)} · ${shortModel(agent.model)}${agent.isBackground ? ' · 背景' : ''}`)
    if (load && (await loadFeature($, load.source, load.origin))) {
      await enterWorkflow($, false)
      if (!shown) await openPane($)
    }
    await status($, workflow)

    return started
  }).catch((_$, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      await patchAgent($, e.agentId, a => (a.phase === 'spawned' ? { ...a, phase: 'reading' } : a))
    }

    return next(e)
  })

  // The lead merging a ticket branch into the integration branch.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const s = await readSwarm($)
    if (!isShown(s) || !s.feature) return next(e)
    const n = sourceById(s.feature.sourceId, workflow).mergedTicket(e.command, s.feature)
    if (n === undefined) return next(e)
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) {
      await updateSwarm($, cur => ({
        ...cur,
        feature: cur.feature && { ...cur.feature, merged: Array.from(new Set([...cur.feature.merged, n])) },
      }))
      await log($, 'lead', `票 ${n} merge 進整合分支`)
      await refreshFeature($, workflow)
    }

    return ran
  }).catch((_$, e, next) => next(e))

  // Every tool call inside a subagent's loop is one step of its progress.
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const s = await readSwarm($)
    const agent = s.agents.find(a => a.id === e.agentId)
    if (!agent || !isLive(agent)) return next(e)

    const { tool, tool_use_id: _id, agentId: _agent, requestMeta: _meta, ...args } = e as unknown as {
      tool: string
      tool_use_id: string
      agentId?: string
      requestMeta?: unknown
      [key: string]: unknown
    }
    const phase = phaseOfCall(agent, tool, args)
    const lastTool = describeCall(tool, args)
    await patchAgent($, agent.id, a => ({ ...a, phase, tools: a.tools + 1, lastTool }))
    if (phase !== agent.phase) {
      await log($, whoOf(agent), `→ ${PHASE_LABEL[phase]}`)
    }

    const ran = await next(e)
    if (ran.deny === undefined && ran.isError === true) {
      await patchAgent($, agent.id, a => ({ ...a, errors: a.errors + 1 }))
    }

    return ran
  }).catch((_$, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    const s = await readSwarm($)
    const agent = s.agents.find(a => a.id === e.agentId)
    if (!agent) return next(e)

    const at = await $.clock.now()
    const isFailed = e.isAborted || e.reason === 'error' || e.reason === 'refusal'
    const usage = e.usage
    const tokens = usage
      ? usage.input_tokens + usage.output_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
      : undefined
    await patchAgent($, agent.id, a => ({
      ...a,
      phase: isFailed ? 'failed' : 'done',
      endedAt: at,
      tokens,
    }))
    await log(
      $,
      whoOf(agent),
      `${isFailed ? '失敗' : '完成'} · ${fmtDuration(e.durationMs)} · ${agent.tools} 次工具${e.reason === 'answer' ? '' : ` · ${e.reason}`}`,
    )
    if (isShown(await readSwarm($))) await refreshFeature($, workflow)
    await status($, workflow)

    return next(e)
  })

  // ------------------------------------------------------------ drawing

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = await readSwarm($)
    const now = await $.clock.now()
    return drawPane($, e, { s, model: paneModelOf(s, isShown(s)), now, workflow, isAnimated })
  })
}
