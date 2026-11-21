/**
 * Shared filesystem path helpers for DeepSeek Harness user data.
 *
 * @module @deepseek-ai/dsh-home-paths
 */

import { existsSync, readFileSync } from 'node:fs'
import { opendir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Directory name for the default DeepSeek Harness home under the OS home. */
export const DSH_HOME_DIR_NAME = '.dsh'

/** Stable user-facing display form for the default DeepSeek Harness home. */
export const DEFAULT_DSH_HOME_DISPLAY = `~/${DSH_HOME_DIR_NAME}`

/** Environment variable that overrides the default DeepSeek Harness home. */
export const DSH_HOME_ENV = 'DSH_HOME'

/** Directory name for the default shared agent configuration root under the OS home. */
export const AGENTS_HOME_DIR_NAME = '.agents'

/** Stable user-facing display form for the default shared agent configuration root. */
export const DEFAULT_AGENTS_HOME_DISPLAY = `~/${AGENTS_HOME_DIR_NAME}`

/** Environment variable that overrides the default shared agent configuration root. */
export const AGENTS_HOME_ENV = 'DSH_AGENTS_HOME'

/**
 * Give a native filesystem watcher one canonical spelling of a path, even
 * when its final components do not exist yet. The deepest existing ancestor
 * is resolved through {@link realpath}; when a suffix is missing, that
 * ancestor is also proved to be an enumerable directory before the suffix is
 * restored. This prevents Windows from treating a regular-file ancestor as
 * ordinary absence, and prevents short-name aliases from being mixed with
 * long paths emitted by the native watcher backend.
 * @param path - Watch target or root, resolved against the current directory.
 * @returns the target with its existing ancestor canonicalized.
 * @throws when ancestor traversal encounters an error other than absence, or
 * the existing ancestor of a missing suffix is not an enumerable directory.
 */
export async function canonicalizeWatchPath(path: string): Promise<string> {
  let current = resolve(path)
  const missing: string[] = []
  while (true) {
    try {
      const canonical = await realpath(current)
      if (missing.length > 0) {
        // A Windows file-as-parent probe reports ENOENT. Opening the resolved
        // ancestor preserves the cross-platform directory requirement.
        const directory = await opendir(canonical)
        await directory.close()
      }
      return join(canonical, ...missing.reverse())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(current)
      /* v8 ignore next -- a filesystem root exists, so traversal resolves before this guard */
      if (parent === current) throw error
      missing.push(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve the default DeepSeek Harness home using Node's platform path rules.
 * @returns the absolute default harness home path.
 */
export function defaultDshHome(): string {
  return join(homedir(), DSH_HOME_DIR_NAME)
}

/**
 * Resolve the default shared agent configuration root using Node's platform path rules.
 * @returns the absolute default shared agent configuration root.
 */
export function defaultAgentsHome(): string {
  return join(homedir(), AGENTS_HOME_DIR_NAME)
}

/**
 * Expand supported tilde prefixes against the operating-system home.
 * @param path - configured path that may begin with `~`, `~/`, or `~\`.
 * @returns the expanded path, or the original value when no supported prefix is present.
 */
export function expandHomePath(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * Resolve one user-data root from an explicit path, an environment override, and a default.
 * @param configured - explicit path, which has highest precedence.
 * @param env - environment mapping to read.
 * @param envName - environment variable that overrides the default.
 * @param fallback - default root, used when neither the explicit path nor the environment provides one.
 * @returns the normalized absolute root.
 */
function resolveRoot(
  configured: string | undefined,
  env: Record<string, string | undefined>,
  envName: string,
  fallback: () => string,
): string {
  const fromEnv = env[envName]
  const selected = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : fallback())
  return resolve(expandHomePath(selected))
}

/**
 * Label one resolved user-data root symbolically for user-facing display.
 * @param resolvedRoot - absolute path returned by the matching resolver.
 * @param defaultRoot - absolute default root whose symbolic label applies to a match.
 * @param defaultLabel - symbolic label for the default root.
 * @param envName - environment variable name that labels any other root.
 * @returns the symbolic label.
 */
function rootDisplay(resolvedRoot: string, defaultRoot: string, defaultLabel: string, envName: string): string {
  return resolvedRoot === resolve(defaultRoot) ? defaultLabel : `$${envName}`
}

/** Config file names that may carry the data root, highest precedence first（F' 配置插层）. */
export const DATA_ROOT_CONFIG_FILES = ['data-root.local.json', 'data-root.json'] as const

/** Marker file that identifies the program root while walking up from this module. */
const PROGRAM_ROOT_MARKER = 'pnpm-workspace.yaml'

/** Cached self-location result; `null` means "not yet discovered". */
let programRootCache: string | undefined | null = null

/**
 * Locate the harness program root by walking up from this module to the nearest
 * `pnpm-workspace.yaml`（F' 配置插层自定位，dsh-home-configfile-1113）。
 *
 * A workspace checkout carries the marker at the repo root, beside the
 * `data-root*.json` files this root exists to find. An npm-packaged install has
 * no marker above it, so this returns `undefined`, the config layer is skipped,
 * and the startup chain may still pass an explicit path instead（方案档 §1.2 兜底）。
 * The answer cannot change within one process, so it is cached.
 * @returns the program root directory, or undefined when no marker exists.
 */
export function findProgramRoot(): string | undefined {
  if (programRootCache !== null) return programRootCache
  let directory = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(directory, PROGRAM_ROOT_MARKER))) {
      programRootCache = directory
      return directory
    }
    const parent = dirname(directory)
    if (parent === directory) {
      programRootCache = undefined
      return undefined
    }
    directory = parent
  }
}

/**
 * Read the configured data root from `<programRoot>/data-root*.json`
 * （F' 配置插层，dsh-home-configfile-1113）：本机覆盖 `data-root.local.json`
 * 先于入仓模板 `data-root.json`。缺文件、key 缺失或空值 → 跳下一层；
 * JSON 损坏、顶层非对象或 `dataRoot` 非字符串 → 响亮抛错（配置 = 单一事实源，
 * 不静默回落；同 m-note 侧约定，方案档 §2.4）。
 * @param programRoot directory holding the config files.
 * @returns the raw configured value (`~` expands later in {@link resolveRoot}), or undefined when no layer provides one.
 */
function readDataRootConfig(programRoot: string): string | undefined {
  for (const name of DATA_ROOT_CONFIG_FILES) {
    const file = join(programRoot, name)
    if (!existsSync(file)) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`${file}: ${(error as Error).message}`)
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${file}: expected a JSON object`)
    }
    const value = (parsed as { dataRoot?: unknown }).dataRoot
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') throw new Error(`${file}: "dataRoot" must be a string`)
    const trimmed = value.trim()
    if (trimmed.length > 0) return trimmed
  }
  return undefined
}

/**
 * F' 配置插层的 fallback：配置文件优先，缺省回落 `~/.dsh`（dsh-home-configfile-1113）。
 * @param programRoot -配置文件目录；省略则经 {@link findProgramRoot} 自定位。
 * @returns the configured data root, or the built-in default when no layer provides one.
 */
function configOrDefault(programRoot?: string): string {
  const root = programRoot ?? findProgramRoot()
  return (root !== undefined ? readDataRootConfig(root) : undefined) ?? defaultDshHome()
}

/**
 * Resolve the single-root DeepSeek Harness home.
 *
 * F' 配置插层（dsh-home-configfile-1113；方案档 = m-note 仓
 * `content/tech/ai/dsh/dsh-home-configfile-1113.md` §〇.1），优先级从高到低：
 * 1. 显式 `configured` 参数（启动链 / SDK 注入）；
 * 2. `$DSH_HOME` —— 仅进程内覆盖层（测试钉扎、spawn 注入），不是全局配置通道；
 * 3. 配置文件 `<programRoot>/data-root.local.json` > `data-root.json`
 *    （程序根自定位见 {@link findProgramRoot}；值可写 `~` 形）；
 * 4. 内置默认 `~/.dsh`。
 *
 * An empty or whitespace-only `$DSH_HOME` is treated as unset, so a blank
 * override never resolves the home to the current working directory.
 * @param configured - explicit harness-home override, which has highest precedence.
 * @param env - environment mapping used to read `DSH_HOME`.
 * @param programRoot - 配置文件目录；省略自动定位，测试 / 启动链可显式传入。
 * @returns the normalized absolute harness home path.
 */
export function resolveDshHome(
  configured?: string,
  env: Record<string, string | undefined> = process.env,
  programRoot?: string,
): string {
  return resolveRoot(configured, env, DSH_HOME_ENV, () => configOrDefault(programRoot))
}

/**
 * Resolve the shared agent configuration root.
 *
 * Precedence, highest first: an explicit configured path, `$DSH_AGENTS_HOME`,
 * then `~/.agents`. The root holds configuration shared with other agent tools,
 * so it stays independent of the DeepSeek Harness home. An empty or
 * whitespace-only `$DSH_AGENTS_HOME` is treated as unset, so a blank override
 * never resolves the root to the current working directory.
 * @param configured - explicit shared-root override, which has highest precedence.
 * @param env - environment mapping used to read `DSH_AGENTS_HOME`.
 * @returns the normalized absolute shared agent configuration root.
 */
export function resolveAgentsHome(configured?: string, env: Record<string, string | undefined> = process.env): string {
  return resolveRoot(configured, env, AGENTS_HOME_ENV, defaultAgentsHome)
}

/**
 * Join path segments onto the resolved DeepSeek Harness home.
 * @param segments - path segments appended to the Harness home; an empty list returns the home itself.
 * @returns the normalized absolute joined path.
 */
export function dshHomePath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/**
 * Join path segments onto the resolved Harness home's `cache` directory without creating it; no arguments returns the directory itself.
 * @param optionsOrSegment - explicit home override, or the first path segment; omission uses the default home resolution.
 * @param segments - additional path segments after the first child, if any.
 * @returns the normalized absolute cache path.
 */
export function dshCachePath(optionsOrSegment: { dshHome?: string } | string = {}, ...segments: string[]): string {
  if (typeof optionsOrSegment === 'string') return dshHomePath('cache', optionsOrSegment, ...segments)
  return join(resolveDshHome(optionsOrSegment.dshHome), 'cache', ...segments)
}

/**
 * Describe a resolved harness home symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default home is labelled
 * `~/.dsh`, and any configured home is labelled `$DSH_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveDshHome}.
 * @returns `~/.dsh` for the default home, otherwise `$DSH_HOME`.
 */
export function dshHomeDisplay(resolvedHome: string): string {
  return rootDisplay(resolvedHome, defaultDshHome(), DEFAULT_DSH_HOME_DISPLAY, DSH_HOME_ENV)
}

/**
 * Describe a resolved shared agent configuration root symbolically for user-facing display.
 *
 * It never returns an absolute machine path: the default root is labelled
 * `~/.agents`, and any configured root is labelled `$DSH_AGENTS_HOME`.
 * @param resolvedHome - the absolute path returned by {@link resolveAgentsHome}.
 * @returns `~/.agents` for the default root, otherwise `$DSH_AGENTS_HOME`.
 */
export function agentsHomeDisplay(resolvedHome: string): string {
  return rootDisplay(resolvedHome, defaultAgentsHome(), DEFAULT_AGENTS_HOME_DISPLAY, AGENTS_HOME_ENV)
}
