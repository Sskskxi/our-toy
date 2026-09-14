import { spawn } from "node:child_process";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local", quiet: true });
dotenv.config({ quiet: true });
const mode = process.argv[2] || "dev";
if (mode === "dev") process.env.WATCHPACK_POLLING ??= "1000";
const children = [
  spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      mode,
      "--hostname",
      "127.0.0.1",
      "--port",
      process.env.PORT || "3000",
      ...(mode === "dev" ? ["--webpack"] : []),
    ],
    { stdio: "inherit" },
  ),
  spawn(process.execPath, ["--import", "tsx", "scripts/worker.ts"], {
    stdio: "inherit",
  }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach((c) => c.kill("SIGTERM"));
  setTimeout(() => process.exit(code), 300).unref();
}
children.forEach((c) => {
  c.on("error", () => stop(1));
  c.on("exit", (code) => stop(code ?? 1));
});
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
