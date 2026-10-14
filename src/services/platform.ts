import { invoke } from "@tauri-apps/api/core";

export type OperatingSystem = "windows" | "macos" | "linux";
export interface RuntimePlatform { os: OperatingSystem; arch: "x86_64" | "aarch64" | "unknown" }
export interface ShellCommand { command: string; args: string[] }

/** Browser detection is a preview fallback; desktop decisions use the native host. */
function browserPlatform(): RuntimePlatform {
  const identity = typeof navigator === "undefined" ? "" : `${navigator.platform} ${navigator.userAgent}`;
  return { os: /Windows|Win32|Win64/i.test(identity) ? "windows" : /Macintosh|MacIntel|MacPPC|Mac OS X/i.test(identity) ? "macos" : "linux", arch: "unknown" };
}

let platform = browserPlatform();
let shell: ShellCommand | undefined;
let initialization: Promise<void> | undefined;

export function getRuntimePlatform(): RuntimePlatform { return platform; }
export function getPrimaryModifierLabel(): string { return platform.os === "macos" ? "⌘" : "Ctrl"; }

export function getDefaultShell(): ShellCommand {
  const fallback = platform.os === "windows" ? { command: "cmd.exe", args: ["/K"] }
    : { command: platform.os === "macos" ? "/bin/zsh" : "/bin/sh", args: ["-l", "-i"] };
  const value = shell ?? fallback;
  return { command: value.command, args: [...value.args] };
}

/** Run trusted installer commands through the same login shell as the terminal. */
export function getShellCommand(commandText: string): ShellCommand {
  const { command, args } = getDefaultShell();
  return { command, args: platform.os === "windows" ? ["/d", "/c", commandText] : [...args.filter(arg => arg !== "-i"), "-c", commandText] };
}

/** Resolve once before rendering so a restored terminal never starts in the wrong shell. */
export function initializeRuntimePlatform(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    const results = await Promise.allSettled([
      invoke<RuntimePlatform>("get_runtime_platform"),
      invoke<ShellCommand>("get_default_shell"),
    ]);
    const runtime = results[0].status === "fulfilled" ? results[0].value : undefined;
    if (runtime && ["windows", "macos", "linux"].includes(runtime.os)) {
      platform = { os: runtime.os, arch: ["x86_64", "aarch64"].includes(runtime.arch) ? runtime.arch : "unknown" };
    }
    const nativeShell = results[1].status === "fulfilled" ? results[1].value : undefined;
    if (nativeShell && typeof nativeShell.command === "string" && nativeShell.command.trim()
      && Array.isArray(nativeShell.args) && nativeShell.args.every(arg => typeof arg === "string")) {
      shell = { command: nativeShell.command, args: [...nativeShell.args] };
    }
  })();
  return initialization;
}
