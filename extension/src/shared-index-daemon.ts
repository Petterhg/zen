import path from "node:path";
import { startSharedIndexServer } from "./shared-index-server.js";
const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory))
  throw new Error("Shared index storage directory required.");
void startSharedIndexServer(directory, {
  grammars: path.join(__dirname, "grammars"),
})
  .then((service) => {
    for (const signal of ["SIGTERM", "SIGINT"] as const)
      process.once(signal, () => void service.close());
  })
  .catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE")
      console.error(
        "Zen shared index could not start:",
        error instanceof Error ? error.message : "Unknown error",
      );
    process.exitCode =
      (error as NodeJS.ErrnoException).code === "EADDRINUSE" ? 0 : 1;
  });
