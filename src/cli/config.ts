import path from "node:path";
import { pathToFileURL } from "node:url";
import type { MiddlewareDefinition } from "../core/types.ts";

export type RoutedConfig = {
  /** Global middleware applied to all routes (runs before directory middleware). */
  middleware?: MiddlewareDefinition<any, any>[];
  /** Path to the routes directory (relative to config file or cwd). */
  routesDir: string;
  /** Path to the generated output file. */
  outFile: string;
  dev?: {
    /** Command to spawn the user's server. */
    command: string;
    /** Additional directories to watch beyond routesDir. */
    watchDirs?: string[];
  };
  openapi?: {
    /** API title for the OpenAPI spec. */
    title: string;
    /** API version for the OpenAPI spec. */
    version: string;
    /** Optional API description. */
    description?: string;
    /** Optional server URLs. */
    servers?: Array<{ url: string; description?: string }>;
    /** Output path for the OpenAPI spec (JSON). Relative to cwd. */
    outFile?: string;
  };
  client?: {
    /** Output path for the generated type-safe client. Relative to cwd. */
    outFile: string;
  };
};

export function defineConfig(config: RoutedConfig): RoutedConfig {
  return config;
}

const CONFIG_FILES = [
  "routed.config.ts",
  "routed.config.js",
  "routed.config.mjs",
];

export async function loadConfig(cwd: string): Promise<{
  config: RoutedConfig;
  configPath: string;
}> {
  for (const file of CONFIG_FILES) {
    const configPath = path.join(cwd, file);
    const exists = await Bun.file(configPath).exists();
    if (!exists) continue;

    const url = pathToFileURL(configPath).toString();
    const mod = await import(url);
    const config: RoutedConfig = mod.default;

    if (!config.routesDir) {
      throw new Error(`routed config is missing "routesDir" in ${file}`);
    }
    if (!config.outFile) {
      throw new Error(`routed config is missing "outFile" in ${file}`);
    }

    return {
      config: {
        ...config,
        routesDir: path.resolve(cwd, config.routesDir),
        outFile: path.resolve(cwd, config.outFile),
      },
      configPath,
    };
  }

  throw new Error(
    `No routed config found. Create one of: ${CONFIG_FILES.join(", ")}`,
  );
}
