# Commands and skills

Every conversation input includes **Commands** and **Skills** buttons: structured
Claude/Codex chat, native terminal startup, and terminal follow-ups. Type `/` to
open suggestions. For Codex skills, type `$` anywhere in a prompt.

Use the arrows to navigate, Enter or Tab to insert, and Escape to close the picker.
Selecting an item does not submit a task. Add arguments after the inserted name,
then submit normally. The browser shows descriptions, source and whether an item
requires the native terminal. Refresh after installing or editing definitions.

## Discovery

| Provider | Sources |
| --- | --- |
| Claude Code | User/project `.claude/skills`, `.claude/commands`, enabled installed plugin definitions, and initialization command metadata from the installed CLI. |
| Codex | Native `skills/list` for enabled skills and plugins. Local `.codex/skills`, `.agents/skills`, and `CODEX_HOME/skills` provide a fallback if native metadata is unavailable. Legacy user/project `.codex/prompts` appear as terminal-only `/prompts:name` commands. |
| Gemini | User/project `.gemini/commands` TOML files, `.gemini/skills`, `.agents/skills`, and enabled extensions containing command/skill files. |

Discovery reads bounded metadata; it does not run command bodies, install skills,
or submit model prompts. A 30-second cache limits repeated probes. Failed native
metadata probes produce a visible fallback notice. Lists are bounded to 1,500
entries. Project discovery includes the selected project and the active worktree;
it does not search unrelated ancestors.

Claude plugin names retain their namespace, such as `/plugin:review`. Definitions
marked `user-invocable: false` and disabled native Codex skills stay hidden. Claude
skill overrides and Gemini disabled skill/extension settings are respected.
Live native sessions may need a CLI reload or restart after definitions change.
MCP prompts or enterprise definitions not reported by the initialization catalogue
remain available through the native CLI's own menu.

## Execution

| Input in structured chat | Behavior |
| --- | --- |
| `/help`, `/skills` | Open the picker without submitting a model turn. |
| `/model <id>` | Update the session model; `/model` alone points to the model controls. |
| `/effort <level>` | Update reasoning effort if the installed model reports support. |
| `/fast on` or `/fast off` | Change fast mode, respecting model capabilities. |
| `/plan`, `/code` | Change the session mode. These are app controls in structured chat. |
| `/status` | Show the current session configuration locally. |
| Claude supported command or skill, such as `/review <args>` | Forward its invocation to Claude's native structured input. |
| Codex `$review <task>` | Resolve the enabled skill on the native side and send explicit app-server skill input with its name/path. |
| Terminal-only command, such as Codex `/compact` | Open the native terminal with the existing session binding and send the command after readiness. It is never submitted as a positional model prompt. |
| Unknown slash command | Keep the draft and explain the error without starting a model turn. |

Session controls and terminal handoffs are blocked during an active structured
turn. Supported skill prompts can still accompany additional input. Structured
and native processes cannot run concurrently for the same session.

Gemini remains a native terminal integration. Picking a Gemini skill inserts a
request such as `Use the review skill:`; native skill activation and consent are
handled by Gemini. Native startup/follow-up inputs send their commands to the CLI
directly. Their built-in commands follow the provider's semantics.

## Provider references

- [Codex app-server skill discovery and input](https://learn.chatgpt.com/docs/app-server)
- [Claude skills](https://code.claude.com/docs/en/skills)
- [Claude SDK commands](https://code.claude.com/docs/en/agent-sdk/slash-commands)
- [Gemini custom commands](https://geminicli.com/docs/cli/custom-commands/)
- [Gemini skills](https://geminicli.com/docs/cli/using-agent-skills/)
- [Gemini extensions](https://geminicli.com/docs/extensions/reference/)
