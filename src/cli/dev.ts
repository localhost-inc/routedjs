import path from "node:path";
import { watch } from "chokidar";
import type { RoutedConfig } from "./config.ts";
import { generate } from "./generate.ts";
import { HTTP_METHODS } from "../core/types.ts";

const ROUTE_EXTENSIONS = HTTP_METHODS.map((m) => `.${m}.route.ts`)
  .concat(HTTP_METHODS.map((m) => `.${m}.route.tsx`));

function isRouteFile(filePath: string): boolean {
  return ROUTE_EXTENSIONS.some((ext) => filePath.endsWith(ext));
}

function isMiddlewareFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return base === "_middleware.ts" || base === "_middleware.tsx";
}

function needsRegen(filePath: string): boolean {
  return isRouteFile(filePath) || isMiddlewareFile(filePath);
}

export async function dev(config: RoutedConfig, cwd: string) {
  const { routesDir, outFile } = config;
  const devCommand = config.dev!.command;
  const clientOutFile = config.client?.outFile
    ? path.resolve(cwd, config.client.outFile)
    : undefined;

  // Determine watch directories
  const watchDirs = config.dev?.watchDirs?.map((d) => path.resolve(cwd, d)) ?? [
    // Default: watch the parent of routesDir (usually src/)
    path.dirname(routesDir),
  ];

  // Initial generation
  console.log(`routed: scanning ${path.relative(cwd, routesDir)}`);
  const initial = await generate({ routesDir, outFile, clientOutFile });
  console.log(
    `routed: generated ${path.relative(cwd, outFile)} (${initial.routeCount} routes, ${initial.middlewareCount} middleware)`,
  );

  // Spawn the server process
  let serverProc = spawnServer(devCommand, cwd);

  // Debounce timer
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingRegen = false;

  // Watch for changes
  const watcher = watch(watchDirs, {
    ignoreInitial: true,
    ignored: [
      "**/node_modules/**",
      outFile,
      ...(clientOutFile ? [clientOutFile] : []),
      "**/.git/**",
    ],
  });

  async function handleChange(filePath: string) {
    if (needsRegen(filePath)) {
      pendingRegen = true;
    }

    // Debounce rapid changes
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (pendingRegen) {
        console.log(`routed: regenerating...`);
        const result = await generate({ routesDir, outFile, clientOutFile });
        console.log(
          `routed: generated (${result.routeCount} routes, ${result.middlewareCount} middleware)`,
        );
        pendingRegen = false;
      }

      // Restart server
      console.log(`routed: restarting server...`);
      await killServer(serverProc);
      serverProc = spawnServer(devCommand, cwd);
    }, 100);
  }

  watcher.on("add", handleChange);
  watcher.on("change", handleChange);
  watcher.on("unlink", handleChange);

  console.log(`routed: watching ${watchDirs.map((d) => path.relative(cwd, d)).join(", ")}`);
  console.log(`routed: dev server running`);

  // Graceful shutdown
  const cleanup = async () => {
    console.log("\nrouted: shutting down...");
    await watcher.close();
    await killServer(serverProc);
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

function spawnServer(
  command: string,
  cwd: string,
): ReturnType<typeof Bun.spawn> {
  const [cmd, ...args] = command.split(" ");
  return Bun.spawn([cmd!, ...args], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
}

async function killServer(proc: ReturnType<typeof Bun.spawn>) {
  proc.kill("SIGTERM");
  // Give it a moment to shut down gracefully
  const timeout = setTimeout(() => proc.kill("SIGKILL"), 3000);
  await proc.exited;
  clearTimeout(timeout);
}
