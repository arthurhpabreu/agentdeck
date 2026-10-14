import { nodeBin, run } from "./desktop-tools.mjs";

const [command = "dev", ...args] = process.argv.slice(2);
if (command === "build") {
  run(process.execPath, [nodeBin("typescript", "tsc")]);
  run(process.execPath, [nodeBin("vite", "vite"), "build", ...args]);
} else if (command === "dev") {
  run(process.execPath, [nodeBin("vite", "vite"), ...args]);
} else {
  throw new Error(`Unsupported frontend command: ${command}`);
}
