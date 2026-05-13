import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { generate } from "../../cli/generate.ts";

const repoRoot = path.resolve(import.meta.dir, "../../..");

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeRoute(
  routesDir: string,
  fileName: string,
  source: string,
): Promise<void> {
  const filePath = path.join(routesDir, fileName);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, source);
}

async function runTsc(entryFile: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const tsconfigFile = path.join(path.dirname(entryFile), "tsconfig.json");
  await writeFile(
    tsconfigFile,
    JSON.stringify(
      {
        compilerOptions: {
          module: "preserve",
          moduleResolution: "bundler",
          target: "ESNext",
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          strict: true,
          skipLibCheck: true,
          baseUrl: repoRoot,
          paths: {
            routedjs: ["./src/index.ts"],
            "routedjs/hono": ["./src/frameworks/hono.ts"],
          },
        },
        files: [path.basename(entryFile)],
      },
      null,
      2,
    ),
  );

  const proc = Bun.spawn(
    [
      "./node_modules/.bin/tsc",
      "--noEmit",
      "--project",
      tsconfigFile,
    ],
    {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
}

describe("generated Hono app client inference", () => {
  test("preserves request and response typing through hc()", async () => {
    const tempDir = await mkdtemp(path.join(repoRoot, ".tmp-hono-codegen-"));
    tempDirs.push(tempDir);

    const routesDir = path.join(tempDir, "routes");
    const outFile = path.join(tempDir, "routed.gen.ts");

    await writeRoute(
      routesDir,
      "_middleware.ts",
      [
        'import { createMiddleware } from "routedjs";',
        "",
        "export default createMiddleware(async ({ next }) => {",
        "  await next();",
        "});",
        "",
      ].join("\n"),
    );

    await writeRoute(
      routesDir,
      "health.get.route.ts",
      [
        'import { createRoute } from "routedjs";',
        "",
        "export default createRoute({",
        "  handler: async () => ({ ok: true as const }),",
        "});",
        "",
      ].join("\n"),
    );

    await writeRoute(
      routesDir,
      "users/_middleware.ts",
      [
        'import { createMiddleware } from "routedjs";',
        "",
        "export default createMiddleware(async ({ next }) => {",
        "  await next();",
        "});",
        "",
      ].join("\n"),
    );

    await writeRoute(
      routesDir,
      "users/index.get.route.ts",
      [
        'import { createRoute } from "routedjs";',
        'import { z } from "zod";',
        "",
        "export default createRoute({",
        "  schemas: {",
        "    query: z.object({",
        "      limit: z.number().optional(),",
        "    }),",
        "  },",
        "  handler: async ({ query }) => ({ users: [], limit: query?.limit }),",
        "});",
        "",
      ].join("\n"),
    );

    await writeRoute(
      routesDir,
      "users/index.post.route.ts",
      [
        'import { createRoute } from "routedjs";',
        'import { z } from "zod";',
        "",
        "export default createRoute({",
        "  schemas: {",
        "    body: z.object({",
        "      name: z.string(),",
        "      email: z.string().email(),",
        "    }),",
        "  },",
        '  handler: async ({ body }) => ({ id: "1", ...body }),',
        "});",
        "",
      ].join("\n"),
    );

    await generate({
      routesDir,
      outFile,
      framework: "hono",
    });

    const typecheckFile = path.join(tempDir, "client-check.ts");
    await writeFile(
      typecheckFile,
      [
        'import { hc } from "hono/client";',
        'import { app } from "./routed.gen.ts";',
        "",
        "const client = hc<typeof app>(\"http://localhost\");",
        "",
        "const listUsersRequest = {",
        "  query: { limit: 5 },",
        "} satisfies Parameters<typeof client.users.$get>[0];",
        "",
        "const createUserRequest = {",
        '  json: { name: "Ada", email: "ada@example.com" },',
        "} satisfies Parameters<typeof client.users.$post>[0];",
        "",
        "const invalidCreateUserRequest: Parameters<typeof client.users.$post>[0] = {",
        "  // @ts-expect-error body routes must accept `json`, not `body`",
        '  body: { name: "Ada", email: "ada@example.com" },',
        "};",
        "",
        "async function assertClientInference() {",
        "  const healthRes = await client.health.$get();",
        "  const health = await healthRes.json();",
        "  const healthOk: { ok: true } = health;",
        "  // @ts-expect-error response body must not widen to `never` or `unknown`",
        "  const healthWrong: { wrong: number } = health;",
        "",
        "  const listUsersRes = await client.users.$get(listUsersRequest);",
        "  const listUsers = await listUsersRes.json();",
        "  const listUsersShape: { users: never[]; limit?: number | undefined } = listUsers;",
        "  // @ts-expect-error response body must preserve the generated query route shape",
        "  const listUsersWrong: { wrong: number } = listUsers;",
        "",
        "  const createUserRes = await client.users.$post(createUserRequest);",
        "  const createdUser = await createUserRes.json();",
        "  const createdUserShape: { id: string; name: string; email: string } = createdUser;",
        "  // @ts-expect-error response body must preserve the generated body route shape",
        "  const createdUserWrong: { wrong: number } = createdUser;",
        "",
        "  void healthOk;",
        "  void healthWrong;",
        "  void listUsersShape;",
        "  void listUsersWrong;",
        "  void createdUserShape;",
        "  void createdUserWrong;",
        "}",
        "",
        "void client;",
        "void invalidCreateUserRequest;",
        "void assertClientInference;",
        "",
      ].join("\n"),
    );

    const tsc = await runTsc(typecheckFile);
    expect(tsc.exitCode, `${tsc.stdout}\n${tsc.stderr}`).toBe(0);
  });
});
