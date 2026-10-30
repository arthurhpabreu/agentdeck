# Conversation context and history

Automatic compaction is enabled for Claude Code and Codex structured chats.
Open **Conversation context** in the composer's action row to change the prompt or
context token limit, inspect the counters, or disable automatic compaction.
Preferences are saved per conversation. Gemini uses the native terminal and its
own context controls.

## When compaction runs

Before a new request, Agent Deck checks whether the previous context contains at
least 50 prompts or whether the estimated next context reaches 200,000 tokens.
Either condition triggers compaction. The prompt limit accepts 5–100; the token
limit accepts 8,000–500,000. These are application thresholds, not a guarantee
that every selected model supports that context size.

When the provider reports its model context window, the effective token threshold
is the lower of the configured limit and that window minus a reserve for replies,
tool results and provider instructions. The next request's text, changed conversation
goal and attachment paths count toward the estimate. Files are passed by path;
their contents count when read by the agent. Image tokenization cannot be inferred
reliably from file size. The context control shows the reported window, effective
threshold, reserve and projected context including the current draft.

A request whose text alone exceeds a known model window is kept in the composer
without launching a turn. Attach reference text as a file to read in sections, or
split the request. An unknown provider window remains explicitly unknown rather
than being guessed from the model name.

After a confirmed compaction, the token threshold waits until five new prompts
have been accepted before it can trigger another application-requested compaction.
This prevents compacting every request when a provider's summary or subsequent
tool output remains above the configured limit. Pressure against a reported model
window and substantial new input bypass this interval. The prompt threshold still
applies; provider-native automatic compaction remains independent of this interval.

The enabled old default pair (20 prompts / 64,000 tokens) migrates once to the new
defaults. Other custom limits and explicit opt-out remain unchanged. Policies saved
by 0.6.4 include a revision marker, so explicitly choosing the old pair afterwards
is preserved across restarts. Old policies do not record whether the default pair
was explicitly selected; an enabled unversioned matching pair is treated as default.

The check runs between responses. Messages submitted while an agent is working
continue to use live input. While a pre-request compaction is running, additional
messages queue until the original request can start. Provider automatic compaction
inside a long agent task is also recognized when reported by its native protocol.

The token counter uses the latest main-agent model context when available,
including cached input and model output. It does not use cumulative billable
tokens, which can count the same context repeatedly. Otherwise the interface
labels a conservative UTF-8 byte estimate. Tool activity, hidden provider context,
and model-specific tokenization mean an estimate cannot be exact. Attachments and
native history can require the provider's own context management before Agent Deck
receives a measured context update.
Subagent output is displayed and archived separately without being added to the
main-agent estimate; any returned results included in the main context are covered
by the provider's measured reading or main-agent output.

## Continuation and failures

Codex resumes the same thread with `excludeTurns: true`, retaining native model
context while avoiding retransmission of its full transcript on every response.
It requests `thread/compact/start`. Its scheduling
acknowledgment is insufficient: Agent Deck waits for a confirmed compaction item
and the successful completion of its turn before sending the user request.
Claude Code receives `/compact` in its resumed streaming session; Agent Deck waits
for `compact_boundary` and a successful result before submitting the real request.
Compaction preserves goals, constraints, decisions and pending work through the
provider's summary. Summaries can omit details; the complete local transcript
remains available to the user.

A failure, unsupported CLI command or a finished compaction without confirmation
does not start a fresh provider conversation or send the pending task. The pending
request is restored in the composer. After 180 seconds, an ongoing compaction
reports that it is still waiting. Compaction stops after five minutes without
meaningful protocol progress or fifteen minutes total, leaving the conversation
and pending request available for recovery.
Retry after correcting a provider error,
or disable automatic compaction to continue using native context management.
Stopping during compaction terminates the current provider process as it does
during a normal response. Counters reset only on confirmed compaction. Lifetime
usage remains cumulative and includes compaction usage when the provider reports it.

## Starting a new chat with continuity

Use **New chat with context** in the chat header or conversation-context control
when a separate conversation is useful, or the existing thread cannot recover.
The default for ongoing work remains compacting and resuming the existing thread.
Opening a new chat is a deliberate user action and does not run a model request.

Agent Deck first commits and reads the full locally stored transcript, then writes
a continuation archive into its local attachment storage. It preserves message
text, tool commands/results, attachment references, original session metadata,
goal and pending draft. Large archives use binary parts with a JSON manifest so
the UTF-8 transcript can be reconstructed without shortening it. Failed archive
writes do not create a new chat or replace the original draft.

The new chat uses the same provider, model, permissions, working directory and
existing worktree, but gets a separate provider conversation ID on its first turn.
Its editable continuation draft contains selected original and recent messages,
the project goal and references to the complete local archive. It instructs the
agent to consult that archive selectively, check existing results and resume
unfinished work. The original conversation stays available from the continuation
banner. This is an excerpt plus an accessible archive, not a promise that every
old token fits into the new model window or that hidden provider state is copied.

Protocol references: [Codex App Server](https://learn.chatgpt.com/docs/app-server)
and [Claude Agent SDK commands](https://code.claude.com/docs/en/agent-sdk/slash-commands).

## Terminal activity and recovery

Tool cards show the command, working directory, available output and exit status
reported by the provider. File, search, fetch and subagent tools name their file,
pattern, URL or task in the summary; edits and Codex file changes open as a
red/green line diff and writes as a content preview. Input that cannot be parsed
completely is shown as received. Tool details start collapsed, including running, failed
and approval-blocked tools. Click the summary to open or close a card; incoming
output and status changes preserve your choice. Long output starts with its latest
lines and can be expanded or copied. Codex streams output deltas;
Claude shows the progress and results exposed by its CLI protocol.

The activity indicator separates the last meaningful event from process heartbeats.
A live process is not proof that a task is advancing. Quiet turns expose **Check
process** and **Stop response** controls. Checking the native process can recover a
completion event missed by the interface without launching another model request.

Codex connection setup and thread loading each have a two-minute deadline. A
missing turn-start acknowledgment reports uncertain acceptance; recovery prepares
a follow-up draft instead of replaying the original request. Already running
model turns and tools have no new inactivity deadline. Codex's native retry
notifications remain recoverable while the provider retries the connection.
After confirmed native completion and delivery of queued inputs, a Codex transport
that fails to exit is closed after ten seconds without discarding its result.
Claude's print process is allowed to exit on its own: a successful turn result
can precede background commands or subagents and a subsequent response with their
results. Closing its input does not establish that this background work is done;
Agent Deck keeps the response active until the process exits. See Claude Code's
[background task lifecycle](https://code.claude.com/docs/en/headless#background-tasks-at-exit).

An MCP OAuth refresh failure, such as a disconnected Miro login, is displayed as
an integration warning with the connector name for eight seconds after a new
warning event. It can be dismissed immediately; duplicate events do not extend
its lifetime, and saved history cannot restore the banner. It is separate from
model errors and does not reset meaningful-activity timers or overwrite the current work state.
Repair that connector's login in the native terminal. Compacting or starting a
new chat does not repair an expired external login.

## Local chat archive

Older chat messages migrate from `agentdeck-chat-v1` localStorage into the local
`agentdeck-chat-history-v1` IndexedDB database. Each changed message is saved as
a separate record; conversation metadata is committed in the same transaction.
The original localStorage transcript is not replaced with a bounded cache until
archive writes succeed. No cloud upload is introduced.

After a successful save, inactive history is evicted from the live store beyond
200 messages or roughly 512,000 text characters, including terminal output and
commands. Completed tools can also leave the live store during a long active turn;
the current input, latest assistant response and running tools remain resident.
Late updates reload the archived item before applying new output, retaining its
identity and order. The UI always
displays at most 80 messages or search results and bounds each page to roughly
160,000 stored text characters, including tool output. The latest message stays
complete even when it alone exceeds that budget. Large messages therefore use
smaller pages instead of forcing the browser to lay out an entire batch of giant
responses at once. **View earlier messages** loads
another page; **Return to latest messages** restores the current conversation view.
Search includes archived text, titles and attachment names. Markdown export includes
the full transcript. Very large responses display as plain text, retaining copy
and export support.

The archive removes the old localStorage size bottleneck, but available device
storage still limits how much history can be saved. A failed save displays the
storage alert and keeps unsaved messages in memory rather than evicting them.
Retrying after storage becomes available persists the pending records. Removing
a conversation also removes its local message archive. Clearing application data
still deletes locally stored chats. As with other local applications, force-killing
the process can lose the most recent uncommitted updates.
