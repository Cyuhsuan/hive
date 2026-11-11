[English](README.md) · [繁體中文](README.zh-TW.md) · [日本語](README.ja.md)

# hive

A pane beside the chat that shows, live, what the session's subagents are doing; when you opt into a workflow, it also draws the tickets, the steps and the overall progress.

![The pane: nine tickets in four steps, with subagents running, in review, starting, failed and done](docs/screenshot.png)

The picture above is a mock-up of what the `mattpocock-skills` Workflow actually draws: two tickets merged, four subagents testing, editing, reviewing and starting, one failed, three done.

> **Upgrading from 0.1**: 0.1 assumed you run implement-spec. Since 0.3 the pane only observes subagents by default. To get the original Feature box, Steps and phase bar back, set `workflow` to `mattpocock-skills` (see "[Settings](#settings)").

> **Upgrading from 0.8**: since 0.9 the text the pane generates defaults to English. To keep Traditional Chinese, set `language` to `zh-TW` (see "[Settings](#settings)").

## Install

At the prompt of a terminal session, enter:

```
/plugin install hive --marketplace Cyuhsuan/hive
```

Then press `y` to add the marketplace and pick the install scope (the default is user).

You can also install from the shell:

```bash
claude plugin install hive --marketplace Cyuhsuan/hive
```

The desktop app cannot run `/plugin`: click the + beside the prompt box, choose Plugins, add the marketplace with `Cyuhsuan/hive`, then add the plugin.

### Requirements

This mod uses only the `claude-code` module the Claude Code engine provides. It needs no npm packages, other plugins, particular agent types or MCP servers, and works on macOS, Linux and Windows (both `\` and `/` are recognized in paths).

Only GitHub tickets need something extra: a logged-in `gh` (the GitHub CLI). The mod reads tickets only through it and never sends an HTTP request with a token itself.

## Usage

| Command | What it does |
| --- | --- |
| `/swarm` | Opens the pane and shows the current Workflow and Ticket source |
| `/swarm <issues folder>` | Loads the local tickets in that folder |
| `/swarm #N`, `/swarm <issue URL>` | Loads tickets starting from that GitHub issue (an issue with no parent spec loads as the "Standalone ticket" batch, see "[GitHub tickets](#github-tickets)") |
| `/swarm reset` | Clears the record and returns to Observe |

- Resize the pane by dragging its edge with the mouse; the contents reflow.
- The status bar shows "swarm N run · M done"; in the Workflow view it is followed by "tickets N/M", matching the pane's ticket count (a ticket merged into the integration branch or resolved on its face counts as done).
- State is kept in the session's `$.state`, so a hot reload does not lose it.

## Settings

Three fields appear at install time and in `/config` (user level).

`workflow`:

| Value | Meaning |
| --- | --- |
| `none` (default) | Observe. Recognizes no skill or ticket-file convention. |
| `mattpocock-skills` | Applies the built-in mattpocock-skills Workflow. |

`animation`:

| Value | Meaning |
| --- | --- |
| `on` (default) | The pane moves while a subagent runs, see "[Animation](#animation)". |
| `off` | The pane is still: the in-progress icon is `●`, redrawn every 2 seconds. Also use this value when the terminal font cannot show the spinner. |

`language`:

| Value | Meaning |
| --- | --- |
| `en` (default) | English. |
| `zh-TW` | Traditional Chinese. |
| `ja` | Japanese. |

The Language covers the pane, the status bar, the session log, the `/swarm` help and replies, and the labels and failure reasons of the Ticket source; content read in as is, such as ticket titles, subagent descriptions and tool commands, is shown unchanged. A value outside the list counts as unset, that is, English.

Changing a setting mid-session reloads the mod and the new value takes effect immediately:

- Changed to `none`: the Feature box of the Workflow view disappears and the pane goes back to Observe; Agent cards and the log stay.
- Changed to `mattpocock-skills`: it does not go back and pick up what it missed earlier; tickets load at the next trigger.

## Animation

The Animation means one thing only: a subagent is running. With no subagent running, the pane is completely still.

![The pane animation: the spinners of running Agent cards and ticket icons turn in sync, a band of light slides across the Feature progress bar; failed and done cards stay still](docs/animation-loop.gif)

- **The status dot of an Agent card**: a card that is still running (including one just dispatched or in review) shows a turning spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`); done and failed cards keep `✓` and `✗`.
- **The icon of a Ticket**: a ticket that a subagent is working on has its icon in the same cell as that card's spinner, turning in sync. A ticket in progress with no subagent working on it does not move.
- **The Feature progress bar**: a soft band of light slides left to right across the filled part, about 2 seconds a pass, fading in at the left end and out at the leading edge, and never touching the unfinished part; at 0%, at 100%, or with no subagent running there is no band.

The phase progress bar of an Agent card and the status bar do not move. While the Animation runs the pane redraws about every 0.06 seconds, and only while the pane is shown.

## Observe

Every subagent that is dispatched is recorded. The pane does not open by itself and only the status bar updates; enter `/swarm` to open it.

- **Lead box**: the main session and its model, and how many subagents have been dispatched.
- **Agent card**: the title is the subagent's description and type; the second line is what it is doing now (reading, editing, testing and the like, estimated from tool calls) and the number of tool calls. When there are errors `⚠ N err` appears, and failed cards sort first with a red frame. All running and failed cards are listed; of the done ones only the latest 5, and the rest collapse into one line, "N more done".
- **Session log**: the latest 5 dispatches, completions and failures.

Under `none`, `/swarm <issues folder>` still loads the local tickets in that folder.

## Workflow view (`mattpocock-skills`)

### When it starts

At any of these moments the pane opens by itself and loads the tickets:

1. The main session calls `/implement-spec`, or you enter `/implement-spec` yourself (both behave the same; running it again resets and starts over: old tickets, ended Agent cards and the log are cleared, and Agent cards still running stay but no longer correspond to any ticket);
2. A dispatched subagent's prompt points at a ticket (`…/issues/NN-*.md`);
3. You enter `/swarm <issues folder>`.

When entered through 2 or 3, subagents recorded earlier do not disappear because of the entry; if a different batch of tickets is later switched to, only then are ended cards cleared (see below). When the Ticket source is GitHub and this batch is entirely done (merged into the integration branch or resolved on its face), if a subagent's prompt points at a ticket of another spec, or at an open Standalone ticket (an issue with no parent spec), the pane loads that batch instead: ended (done or failed) Agent cards are cleared, and running cards and the log are kept; while this batch still has unfinished tickets it does not switch. The exception is the Standalone-ticket batch: whether or not it is done, a prompt that points at another Standalone ticket joins this batch (a ticket of some spec follows the rule above). When the Ticket source is local ticket files there is no "switch only when done" limit: when a prompt points at ticket files in another folder (`…/issues/NN-*.md`), the pane loads that folder, clearing ended cards in the same way. `/swarm` pointing at another batch (`#N`, an issue URL, a folder) is also a switch, with the same result; re-reading the same batch, a new child ticket added to the same spec, a Standalone-ticket batch joined by another Standalone ticket, loading the first batch and a failed load do not count, and the cards stay. "Switching batch" goes by the batch on screen: after the setting is changed to `none`, the state still holds the batch from before but the screen is Observe, so `/swarm <folder>` counts as loading the first batch and ended cards are not cleared. A subagent whose type or description contains words like implement, review or merg starts nothing. Once in the Workflow view it never goes back to Observe by itself, until `/swarm reset` or a new session.

### What it shows

On top of what Observe shows, there is more:

- **Workflow status line**: for example "Workflow mattpocock-skills · Ticket source Local"; when the Ticket source is unavailable the reason is given on the same line.
- **Feature box**: the overall progress bar (a ticket merged into the integration branch or resolved on its face counts as whole, the rest by the share of acceptance items ticked), the ticket count and the current step, and below it one row per Step. The Step being worked spells out ticket titles and acceptance counts; the other Steps draw only "icon + ticket number".
- **The Lead box** also shows how many tickets have been merged.
- **Agent card of a subagent pointed at a ticket**: the title is the ticket number and name, its Step and the elapsed time; the second line is the phase progress bar (reading → editing → testing → merging → committing); the third line is the latest tool call. A subagent not pointed at a ticket is still an Observe Agent card.

A ticket's icon and color are the same set as the status dot and frame color of the Agent card responsible for it:

| Icon | Meaning |
| --- | --- |
| `◆` light green | Merged into the integration branch |
| `✓` light green | Resolved on its face / subagent done |
| spinner, yellow | A subagent is working on it (`●` when `animation` is `off`) |
| `✗` red | Failed |
| `○` | Ready to start |
| `·` gray | Blocked by earlier tickets |

Phases are estimated from the subagent's tool calls: a tool whose name contains edit/write/replace/insert counts as editing, `dotnet test`, `npm test` and the like as testing, `git merge` as merging, `git commit` as committing. A subagent whose type name contains review is always shown as reviewing.

When the pane is narrower than 40 columns it condenses automatically: an Agent card title keeps only the ticket number and phase, the log keeps only the ticket number, and the boxes and topology lines stay.

### Ticket source

Before loading tickets, the mod reads the project's `docs/agents/issue-tracker.md` and judges the Ticket source by its first-line title:

| First line | Result |
| --- | --- |
| `# Issue tracker: Local Markdown`, or the file does not exist | Local tickets: `.scratch/<feature>/issues/NN-*.md` |
| `# Issue tracker: GitHub` | Tickets are GitHub issues, see the next section |
| `# Issue tracker: GitLab` or not recognized | Stays Observe, and the status line gives the reason |

This file is re-read every time tickets are to be loaded, and also when the user enters `/swarm`; it is not read at session start. It is judged again after `/swarm reset`.

### GitHub tickets

- **Starting point**: a spec issue, whose number comes from the argument of `/implement-spec` or from `/swarm #N` / `/swarm <issue URL>`. This batch of tickets is its sub-issues; when there are no sub-issues, it is the issues whose body points to it with `Part of #N` or a `## Parent` section.
- **Standalone ticket**: an issue with no parent spec (no parent, and the body has no `Part of #N` or `## Parent`). Standalone tickets in the same piece of work (from a pane reset to the next reset) are drawn in the same batch, whose box is always named "Standalone tickets" and is not mixed with a spec's tickets in one batch; dependencies, progress, merge and re-reading are all the same as for a spec's batch.
  - **Loading from an argument**: every `#N`, issue URL and bare number in the argument (`/implement-spec`, `/swarm`) is judged in order of appearance. When there is a spec (an issue with child tickets) or a child ticket of some spec, the batch of the first spec is loaded and the other numbers are ignored; otherwise these tickets form the Standalone-ticket batch, even if there is only one. Numbers that do not exist and PRs are skipped, and when all are skipped it says the tickets cannot be read. A spec not yet split into tickets is therefore drawn as one Standalone ticket. "Bare number" means the whole argument is numbers (such as `/swarm 30 31`); mixed with `#N` or a URL, bare numbers do not count (`#30 31` takes only 30). When `/swarm #N` points at a Standalone ticket and the pane is already a Standalone-ticket batch, it joins that batch (`merged`, Agent cards and the log are kept) and does not reset; the starting skill always starts from a new batch.
  - **Joining from a subagent prompt**: the first three numbers in the prompt are looked at in order of appearance, and the first that matches counts: one with a parent spec is a spec's ticket; one with no parent, open and not a PR is a Standalone ticket (a closed issue or a PR never becomes a Standalone ticket).
- **Dependencies and progress**: the tickets blocking a ticket come from GitHub's native blocked-by relation; when there is none, the `#N` in the body's `## Blocked by` section are read, counting only tickets in the same batch. A closed issue is resolved; a ticket merged into the integration branch counts as done even if still open; the rest are counted by the body's `- [ ]` / `- [x]`.
- **Loading from a subagent prompt**: when no tickets are loaded yet, if an issue URL or `#N` in a subagent prompt has a parent that can be looked up, the parent is the starting point of the load; once loaded, only numbers belonging to this batch match a ticket, and other numbers (such as a PR) stay Observe cards.
- **merge**: after the main session's merge command succeeds (the branch name contains the ticket number, such as `ticket-12`) the ticket is marked merged; when it does not match, the ticket is shown by its closed state only.
- **Re-reading**: every 30 seconds while a subagent runs, immediately again when a subagent ends and when a merge is detected; also once after the main session successfully runs `gh issue close`, `gh issue reopen` or `gh issue edit` (those run by subagents do not count); when a batch is loaded, `/swarm` without arguments also re-reads.
- **On failure**: it reads through the logged-in `gh` and calls it only when tickets are to be loaded; when `gh` is missing, not logged in or the call fails it stays Observe and the status line gives the reason (for example "Ticket source GitHub (`gh` is not logged in)"); an already loaded batch is kept when a re-read fails.
