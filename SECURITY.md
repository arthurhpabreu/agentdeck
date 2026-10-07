# Security and local data

Agent Deck starts official coding agent CLIs installed on the user's computer. Sign-in stays with those clients. The application can read account usage through existing local credentials; it does not expose those credentials to the UI or copy them into workspace storage.

Code mode enables full machine access by default. Users can turn it off per conversation; Plan remains read only. Review CLI trust and permission settings when running tasks on an unfamiliar checkout.

Documents remain in their selected source folders. Memory, history and preferences persist outside the checkout in the operating system's application data directory. Relevant document and memory excerpts can be sent to the chosen provider as part of a task; opening graphs itself does not call a model.

Do not commit provider directories, app data, vault contents, database exports, real transcripts or credentials. `.gitignore` excludes common local artifacts while preserving source, lockfiles, configuration, icons and tests. Historical machine-specific QA is intentionally local.

Report vulnerabilities using the private repository's GitHub security reporting channel when enabled, or contact the maintainer through a private channel. Include a sanitized reproduction and affected version; do not disclose secrets in public issues.
