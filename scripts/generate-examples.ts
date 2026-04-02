import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const cliEntry = path.join(repoRoot, "src/cli/index.ts");
const exampleDirs = ["hono", "express", "koa", "elysia"];

for (const exampleDir of exampleDirs) {
  const cwd = path.join(repoRoot, "examples", exampleDir);
  const proc = Bun.spawn(["bun", cliEntry, "generate"], {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
