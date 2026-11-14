import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENTS_HOME_DIR_NAME,
  DEFAULT_AGENTS_HOME_DISPLAY,
  DEFAULT_DSH_HOME_DISPLAY,
  DSH_HOME_DIR_NAME,
  agentsHomeDisplay,
  canonicalizeWatchPath,
  defaultAgentsHome,
  defaultDshHome,
  dshCachePath,
  dshHomeDisplay,
  dshHomePath,
  expandHomePath,
  findProgramRoot,
  resolveAgentsHome,
  resolveDshHome,
} from '@deepseek-ai/dsh-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('dsh path helpers', () => {
  it('owns the shared default DSH home directory name', () => {
    expect(DSH_HOME_DIR_NAME).toBe('.dsh')
    expect(DEFAULT_DSH_HOME_DISPLAY).toBe('~/.dsh')
    expect(defaultDshHome()).toBe(join(homedir(), '.dsh'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('~\\.dsh')).toBe(join(homedir(), '.dsh'))
    expect(expandHomePath('/tmp/.dsh')).toBe('/tmp/.dsh')
    expect(expandHomePath('~other/.dsh')).toBe('~other/.dsh')
  })

  it('resolves explicit path before DSH_HOME and the default', () => {
    const envHome = join(homedir(), 'env-dsh')

    expect(resolveDshHome('/tmp/explicit-dsh', { DSH_HOME: '~/env-dsh' })).toBe(resolve('/tmp/explicit-dsh'))
    expect(resolveDshHome(undefined, { DSH_HOME: '~/env-dsh' })).toBe(envHome)
    expect(resolveDshHome(undefined, {})).toBe(defaultDshHome())
  })

  it('treats an empty or whitespace-only DSH_HOME as unset', () => {
    expect(resolveDshHome(undefined, { DSH_HOME: '' })).toBe(defaultDshHome())
    expect(resolveDshHome(undefined, { DSH_HOME: '   ' })).toBe(defaultDshHome())
  })

  it('joins child segments onto the resolved DSH_HOME', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    expect(dshHomePath()).toBe(join(homedir(), 'env-dsh'))
    expect(dshHomePath('storages', 'cache')).toBe(join(homedir(), 'env-dsh', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(dshHomeDisplay(resolve(defaultDshHome()))).toBe('~/.dsh')
    expect(dshHomeDisplay('/some/other/root')).toBe('$DSH_HOME')
  })

  it('owns the shared default agents home directory name', () => {
    expect(AGENTS_HOME_DIR_NAME).toBe('.agents')
    expect(DEFAULT_AGENTS_HOME_DISPLAY).toBe('~/.agents')
    expect(defaultAgentsHome()).toBe(join(homedir(), '.agents'))
  })

  it('resolves an explicit agents home before DSH_AGENTS_HOME and the default', () => {
    const envHome = join(homedir(), 'env-agents')

    expect(resolveAgentsHome('/tmp/explicit-agents', { DSH_AGENTS_HOME: '~/env-agents' })).toBe(resolve('/tmp/explicit-agents'))
    expect(resolveAgentsHome(undefined, { DSH_AGENTS_HOME: '~/env-agents' })).toBe(envHome)
    expect(resolveAgentsHome(undefined, {})).toBe(defaultAgentsHome())
  })

  it('treats an empty or whitespace-only DSH_AGENTS_HOME as unset', () => {
    expect(resolveAgentsHome(undefined, { DSH_AGENTS_HOME: '' })).toBe(defaultAgentsHome())
    expect(resolveAgentsHome(undefined, { DSH_AGENTS_HOME: '   ' })).toBe(defaultAgentsHome())
  })

  it('labels a resolved agents home by whether it is the default root', () => {
    expect(agentsHomeDisplay(resolve(defaultAgentsHome()))).toBe('~/.agents')
    expect(agentsHomeDisplay('/some/other/root')).toBe('$DSH_AGENTS_HOME')
  })

  it.each([
    [undefined, join(homedir(), '.dsh')],
    ['', join(homedir(), '.dsh')],
    ['   ', join(homedir(), '.dsh')],
    ['~/env-dsh', join(homedir(), 'env-dsh')],
    ['./relative-dsh', resolve('./relative-dsh')],
  ] as const)('resolves cache paths with DSH_HOME=%j', (home, expectedHome) => {
    vi.stubEnv('DSH_HOME', home)
    try {
      expect(dshCachePath()).toBe(join(expectedHome, 'cache'))
      expect(dshCachePath('models', 'index.json')).toBe(join(expectedHome, 'cache', 'models', 'index.json'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('resolves configured cache homes before the environment', () => {
    vi.stubEnv('DSH_HOME', '~/env-dsh')
    try {
      expect(dshCachePath({ dshHome: '~/explicit-dsh' })).toBe(join(homedir(), 'explicit-dsh', 'cache'))
      expect(dshCachePath({ dshHome: './explicit-dsh' }, 'attachments', 'request-images'))
        .toBe(resolve('./explicit-dsh/cache/attachments/request-images'))
      expect(dshCachePath({}, 'attachments')).toBe(join(homedir(), 'env-dsh', 'cache', 'attachments'))
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(alias)).resolves.toBe(await realpath(target))
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

// F' 配置插层（dsh-home-configfile-1113）：dataRoot 配置文件四层语义。
// programRoot 第三参是测试缝——临时目录喂配置，机器无关（本机 local 值恰等于
// 默认值，CI 无 local 走模板 ~/.dsh，两处既有断言因此保持绿）。
describe('dsh home config layer', () => {
  async function makeProgramRoot(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'dsh-program-root-'))
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(root, name), content)
    }
    return root
  }

  it('resolves local over repo over the default', async () => {
    const empty = await makeProgramRoot({})
    expect(resolveDshHome(undefined, {}, empty)).toBe(defaultDshHome())

    const repo = await makeProgramRoot({
      'data-root.json': JSON.stringify({ dataRoot: 'C:/repo-home' }),
    })
    expect(resolveDshHome(undefined, {}, repo)).toBe(resolve('C:/repo-home'))

    await writeFile(join(repo, 'data-root.local.json'), JSON.stringify({ dataRoot: 'C:/local-home' }))
    expect(resolveDshHome(undefined, {}, repo)).toBe(resolve('C:/local-home'))
  })

  it('skips layers whose key is missing or blank', async () => {
    const blank = await makeProgramRoot({
      'data-root.local.json': JSON.stringify({ other: 1 }),
      'data-root.json': JSON.stringify({ dataRoot: '' }),
    })
    expect(resolveDshHome(undefined, {}, blank)).toBe(defaultDshHome())

    await writeFile(join(blank, 'data-root.json'), JSON.stringify({ dataRoot: 'C:/repo-home' }))
    expect(resolveDshHome(undefined, {}, blank)).toBe(resolve('C:/repo-home'))
  })

  it('lets DSH_HOME beat the config file', async () => {
    const root = await makeProgramRoot({
      'data-root.json': JSON.stringify({ dataRoot: 'C:/repo-home' }),
    })
    expect(resolveDshHome(undefined, { DSH_HOME: '~/env-dsh' }, root)).toBe(join(homedir(), 'env-dsh'))
  })

  it('expands a tilde in the configured value', async () => {
    const root = await makeProgramRoot({
      'data-root.json': JSON.stringify({ dataRoot: '~/.dsh' }),
    })
    expect(resolveDshHome(undefined, {}, root)).toBe(defaultDshHome())
  })

  it('throws loudly on malformed config instead of falling back', async () => {
    const badJson = await makeProgramRoot({ 'data-root.local.json': '{bad' })
    expect(() => resolveDshHome(undefined, {}, badJson)).toThrow()

    const notObject = await makeProgramRoot({ 'data-root.local.json': '[]' })
    expect(() => resolveDshHome(undefined, {}, notObject)).toThrow()

    const notString = await makeProgramRoot({ 'data-root.local.json': JSON.stringify({ dataRoot: 42 }) })
    expect(() => resolveDshHome(undefined, {}, notString)).toThrow()
  })

  it('finds the program root by walking up to pnpm-workspace.yaml', () => {
    const root = findProgramRoot()
    expect(root).toBeDefined()
    expect(existsSync(join(root!, 'pnpm-workspace.yaml'))).toBe(true)
    expect(existsSync(join(root!, 'data-root.json'))).toBe(true)
  })
})
