import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "../../..");
const cliEntry = path.join(repoRoot, "src/cli/index.ts");

async function runCli(args: string[], cwd: string) {
  const proc = Bun.spawn([process.execPath, cliEntry, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

describe("routed openapi", () => {
  test("reads routeTree from framework output when framework mode is enabled", async () => {
    const projectDir = await mkdtemp(path.join(repoRoot, ".tmp-openapi-"));

    try {
      const routesDir = path.join(projectDir, "routes");
      await mkdir(routesDir, { recursive: true });

      await writeFile(
        path.join(routesDir, "health.get.route.ts"),
        [
          'import { createRoute } from "routedjs";',
          "",
          "export default createRoute({",
          "  handler: async () => ({ ok: true }),",
          "});",
          "",
        ].join("\n"),
      );

      await writeFile(
        path.join(projectDir, "routed.config.ts"),
        [
          'import { defineConfig } from "routedjs";',
          "",
          "export default defineConfig({",
          '  routesDir: "./routes",',
          '  outFile: "./routed.gen.ts",',
          '  framework: "hono",',
          "  openapi: {",
          '    title: "Test API",',
          '    version: "1.0.0",',
          '    outFile: "./openapi.json",',
          "  },",
          "});",
          "",
        ].join("\n"),
      );

      const generate = await runCli(["generate"], projectDir);
      expect(generate.exitCode, generate.stderr).toBe(0);

      const generatedAppPath = path.join(projectDir, "routed.gen.ts");
      const typedAppBeforeOpenAPI = await readFile(generatedAppPath, "utf-8");
      expect(typedAppBeforeOpenAPI).toContain('import { defineRouteTree } from "routedjs"');
      expect(typedAppBeforeOpenAPI).toContain("export const routeTree = defineRouteTree([");
      expect(typedAppBeforeOpenAPI).toContain('import { Hono } from "hono"');
      expect(typedAppBeforeOpenAPI).toContain("export const app = new Hono()");

      const openapi = await runCli(["openapi"], projectDir);
      expect(openapi.exitCode, `${openapi.stdout}\n${openapi.stderr}`).toBe(0);
      expect(openapi.stdout).toContain("generated routed.gen.ts");

      const typedAppAfterOpenAPI = await readFile(generatedAppPath, "utf-8");
      expect(typedAppAfterOpenAPI).toBe(typedAppBeforeOpenAPI);
      expect(typedAppAfterOpenAPI).toContain("export const routeTree = defineRouteTree([");

      const spec = JSON.parse(
        await readFile(path.join(projectDir, "openapi.json"), "utf-8"),
      ) as {
        openapi: string;
        paths: Record<string, unknown>;
      };

      expect(spec.openapi).toBe("3.1.0");
      expect(spec.paths["/health"]).toBeDefined();
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
