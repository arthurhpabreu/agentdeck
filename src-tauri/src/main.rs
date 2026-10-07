// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Some(code) = agentdeck_lib::memory_runtime::stdio_entry() {
        std::process::exit(code);
    }
    // Read-only diagnostic uses the same collector as the footer, without opening
    // a GUI or starting a conversation. Only sanitized quota fields reach stdout.
    if std::env::args().skip(1).collect::<Vec<_>>() == ["--check-claude-usage"] {
        let usage = agentdeck_lib::provider_usage::diagnostic_claude_usage();
        let result = serde_json::to_writer(std::io::stdout().lock(), &usage);
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }
    agentdeck_lib::run()
}
