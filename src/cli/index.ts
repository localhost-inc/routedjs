#!/usr/bin/env bun

import path from "node:path";
import { loadConfig } from "./config.ts";
import { generate } from "./generate.ts";

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  switch (command) {
    case "generate":
      await runGenerate();
      break;
    case "dev":
      await runDev();
      break;
    case "openapi":
      await runOpenAPI();
      break;
    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

async function runGenerate() {
  const cwd = process.cwd();
  const { config, configPath } = await loadConfig(cwd);

  console.log(`routed: using config ${path.relative(cwd, configPath)}`);
  console.log(`routed: scanning ${path.relative(cwd, config.routesDir)}`);

  const clientOutFile = config.client?.outFile
    ? path.resolve(cwd, config.client.outFile)
    : undefined;

  const result = await generate({
    routesDir: config.routesDir,
    outFile: config.outFile,
    clientOutFile,
  });

  console.log(
    `routed: generated ${path.relative(cwd, config.outFile)} (${result.routeCount} routes, ${result.middlewareCount} middleware)`,
  );

  if (clientOutFile) {
    console.log(`routed: generated ${path.relative(cwd, clientOutFile)} (client)`);
  }
}

async function runOpenAPI() {
  const cwd = process.cwd();
  const { config, configPath } = await loadConfig(cwd);

  if (!config.openapi) {
    console.error("routed: openapi config is required for `routed openapi`");
    console.error("routed: add an openapi section to your config with at least title and version");
    process.exit(1);
  }

  // Ensure the manifest is up to date
  console.log(`routed: scanning ${path.relative(cwd, config.routesDir)}`);
  const genResult = await generate({
    routesDir: config.routesDir,
    outFile: config.outFile,
  });
  console.log(
    `routed: generated ${path.relative(cwd, config.outFile)} (${genResult.routeCount} routes)`,
  );

  // Import the generated route tree
  const { pathToFileURL } = await import("node:url");
  const manifestUrl = pathToFileURL(config.outFile).toString();
  const manifest = await import(manifestUrl);
  const routeTree = manifest.routeTree;

  // Generate the OpenAPI spec
  const { generateOpenAPISpec } = await import("../openapi/index.ts");
  const spec = generateOpenAPISpec(routeTree, {
    info: {
      title: config.openapi.title,
      version: config.openapi.version,
      ...(config.openapi.description ? { description: config.openapi.description } : {}),
    },
    ...(config.openapi.servers ? { servers: config.openapi.servers } : {}),
  });

  const outFile = config.openapi.outFile
    ? path.resolve(cwd, config.openapi.outFile)
    : path.resolve(cwd, "openapi.json");

  await Bun.write(outFile, JSON.stringify(spec, null, 2) + "\n");
  console.log(`routed: wrote ${path.relative(cwd, outFile)}`);
}

async function runDev() {
  // Lazy import to avoid loading chokidar for generate-only usage
  const { dev } = await import("./dev.ts");
  const cwd = process.cwd();
  const { config, configPath } = await loadConfig(cwd);

  if (!config.dev?.command) {
    console.error("routed: dev.command is required in config for `routed dev`");
    process.exit(1);
  }

  console.log(`routed: using config ${path.relative(cwd, configPath)}`);
  await dev(config, cwd);
}

function printUsage() {
  console.log(`
Usage: routed <command>

Commands:
  generate    Scan routes and generate the route manifest
  dev         Watch for changes, regenerate, and run the dev server
  openapi     Generate an OpenAPI spec from your routes
`.trim());
}

main().catch((err) => {
  console.error("routed:", err.message ?? err);
  process.exit(1);
});
