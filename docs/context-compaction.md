# Conversation context and history

Automatic compaction is enabled for Claude Code and Codex structured chats.
Open **Conversation context** beside the model picker to change the prompt or
context token limit, inspect the counters, or disable automatic compaction.
Preferences are saved per conversation. Gemini uses the native terminal and its
own context controls.

## When compaction runs

Before a new request, Agent Deck checks whether the previous context contains at
least 20 prompts or whether the estimated next context reaches 64,000 tokens.
Either condition triggers compaction. The prompt limit accepts 5–100; the token
limit accepts 8,000–500,000. These are application thresholds, not a guarantee
that every selected model supports that context size.

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

## Continuation and failures

Codex resumes the same thread and requests `thread/compact/start`. Its scheduling
acknowledgment is insufficient: Agent Deck waits for a confirmed compaction item
and the successful completion of its turn before sending the user request.
Claude Code receives `/compact` in its resumed streaming session; Agent Deck waits
for `compact_boundary` and a successful result before submitting the real request.
Compaction preserves goals, constraints, decisions and pending work through the
provider's summary. Summaries can omit details; the complete local transcript
remains available to the user.

A failure, unsupported CLI command, missing confirmation or 180-second timeout
does not start a fresh provider conversation or send the pending task. The pending
request is restored in the composer. Retry after correcting the provider issue,
or disable automatic compaction to continue using native context management.
Stopping during compaction terminates the current provider process as it does
during a normal response. Counters reset only on confirmed compaction. Lifetime
usage remains cumulative and includes compaction usage when the provider reports it.

Protocol references: [Codex App Server](https://learn.chatgpt.com/docs/app-server)
and [Claude Agent SDK commands](https://code.claude.com/docs/en/agent-sdk/slash-commands).

## Local chat archive

Older chat messages migrate from `agentdeck-chat-v1` localStorage into the local
`agentdeck-chat-history-v1` IndexedDB database. Each changed message is saved as
a separate record; conversation metadata is committed in the same transaction.
The original localStorage transcript is not replaced with a bounded cache until
archive writes succeed. No cloud upload is introduced.

After a successful save, inactive history is evicted from the live store beyond
200 messages or roughly 512,000 text characters. An active turn remains resident
so streamed updates and queued input retain their message identity. The UI always
displays at most 80 messages or search results. **View earlier messages** loads
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
