import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, checkDirectories, describeConfig } from '../src/config.js';

/** 临时根目录。 */
let root = '';

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'ofdrw-api-config-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('无配置文件时使用内置默认并以工作目录为工作区根', async () => {
    const loaded = await loadConfig({ cwd: root });
    expect(loaded.configPath).toBeUndefined();
    expect(loaded.workspaceRoot).toBe(root);
    expect(loaded.config.server.port).toBe(7860);
    expect(loaded.config.output.format).toBe('json');
    expect(loaded.config.jobs.ttlSec).toBe(300);
    expect(loaded.errors).toEqual([]);
  });

  it('相对路径解析为工作区根下的绝对路径', async () => {
    const loaded = await loadConfig({ cwd: root });
    expect(loaded.workspaceRoot).toBe(root);
    expect(loaded.jobDir).toBe(join(root, 'jobs'));
    expect(loaded.config.logging.dir).toBe(join(root, 'logs'));
  });

  it('显式 workDir 决定工作区根与作业目录', async () => {
    const workDir = join(root, 'ws-a');
    const loaded = await loadConfig({ cwd: root, workDir, env: {} as NodeJS.ProcessEnv });
    expect(loaded.workspaceRoot).toBe(workDir);
    expect(loaded.jobDir).toBe(join(workDir, 'jobs'));
    expect(loaded.config.logging.dir).toBe(join(workDir, 'logs'));
  });

  it('无配置文件与显式工作区时以可执行文件目录为工作区根', async () => {
    const cwd = join(root, 'exec-cwd');
    const execDir = join(root, 'exec-bin');
    await mkdir(cwd, { recursive: true });
    await mkdir(execDir, { recursive: true });

    const loaded = await loadConfig({ cwd, execDir, env: {} as NodeJS.ProcessEnv });
    expect(loaded.configPath).toBeUndefined();
    expect(loaded.workspaceRoot).toBe(execDir);
    expect(loaded.workspaceSource).toBe('exec-dir');
    expect(loaded.jobDir).toBe(join(execDir, 'jobs'));
    expect(loaded.config.logging.dir).toBe(join(execDir, 'logs'));
  });

  it('显式 workDir 优先于可执行文件目录', async () => {
    const cwd = join(root, 'exec-cwd-2');
    const execDir = join(root, 'exec-bin-2');
    const workDir = join(root, 'ws-explicit');
    await mkdir(cwd, { recursive: true });
    await mkdir(execDir, { recursive: true });

    const loaded = await loadConfig({ cwd, execDir, workDir, env: {} as NodeJS.ProcessEnv });
    expect(loaded.workspaceRoot).toBe(workDir);
    expect(loaded.workspaceSource).toBe('cli');
  });

  it('工作目录下的配置文件优先于可执行文件目录', async () => {
    const cwd = join(root, 'exec-cwd-3');
    const execDir = join(root, 'exec-bin-3');
    await mkdir(cwd, { recursive: true });
    await mkdir(execDir, { recursive: true });
    await writeFile(join(cwd, 'api-server-config.yaml'), 'server:\n  port: 7911\n', 'utf8');
    await writeFile(join(execDir, 'api-server-config.yaml'), 'server:\n  port: 7912\n', 'utf8');

    // 命中的配置文件决定工作区根，优先于可执行文件目录。
    const loaded = await loadConfig({ cwd, execDir, env: {} as NodeJS.ProcessEnv });
    expect(loaded.configPath).toBe(join(cwd, 'api-server-config.yaml'));
    expect(loaded.workspaceSource).toBe('config-file-dir');
    expect(loaded.workspaceRoot).toBe(cwd);
    expect(loaded.config.server.port).toBe(7911);
  });

  it('配置文件中的 workspace 决定工作区根，显式 workDir 优先', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const dir = join(root, 'ws-config-field');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'api-server-config.yaml'),
      'workspace: ./ws-from-config\nserver:\n  port: 7901\n',
      'utf8',
    );
    const fromConfig = await loadConfig({ cwd: root, configPath: join(dir, 'api-server-config.yaml'), env: {} as NodeJS.ProcessEnv });
    expect(fromConfig.workspaceRoot).toBe(join(root, 'ws-from-config'));
    expect(fromConfig.workspaceSource).toBe('config');
    expect(fromConfig.config.server.port).toBe(7901);
    expect('workspace' in fromConfig.config).toBe(false);

    const explicit = join(root, 'ws-cli');
    const viaCli = await loadConfig({
      cwd: root,
      workDir: explicit,
      configPath: join(dir, 'api-server-config.yaml'),
      env: {} as NodeJS.ProcessEnv,
    });
    expect(viaCli.workspaceRoot).toBe(explicit);
    expect(viaCli.workspaceSource).toBe('cli');
  });

  it('workspace 指向的目录有配置文件时以该文件为准', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const dir = join(root, 'ws-redirect');
    const target = join(root, 'ws-target');
    await mkdir(dir, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(
      join(dir, 'api-server-config.yaml'),
      `workspace: ${target}\nserver:\n  port: 7902\n`,
      'utf8',
    );
    await writeFile(join(target, 'api-server-config.yaml'), 'server:\n  port: 7903\n', 'utf8');
    const loaded = await loadConfig({ cwd: dir, env: {} as NodeJS.ProcessEnv });
    expect(loaded.configPath).toBe(join(target, 'api-server-config.yaml'));
    expect(loaded.workspaceRoot).toBe(target);
    expect(loaded.config.server.port).toBe(7903);
  });

  it('工作区根下存在配置文件时优先于进程工作目录', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const workDir = join(root, 'ws-config');
    await mkdir(workDir, { recursive: true });
    await writeFile(join(workDir, 'api-server-config.yaml'), 'server:\n  port: 7999\n', 'utf8');
    const loaded = await loadConfig({ cwd: root, workDir, env: {} as NodeJS.ProcessEnv });
    expect(loaded.configPath).toBe(join(workDir, 'api-server-config.yaml'));
    expect(loaded.workspaceRoot).toBe(workDir);
    expect(loaded.config.server.port).toBe(7999);
  });

  it('配置中出现 jobs.workDir 时报未知字段', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const dir = join(root, 'legacy-workdir');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'api-server-config.yaml'), 'jobs:\n  workDir: ./jobs\n', 'utf8');
    const loaded = await loadConfig({ cwd: dir, env: {} as NodeJS.ProcessEnv });
    expect(loaded.errors.join('\n')).toContain('jobs');
  });

  it('字符串标量支持环境变量插值与默认值', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const dir = join(root, 'env');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'api-server-config.yaml'),
      'server:\n  host: ${TEST_HOST:-127.0.0.9}\n  port: ${TEST_PORT}\n',
      'utf8',
    );
    const loaded = await loadConfig({
      cwd: dir,
      env: { TEST_PORT: '9000' } as NodeJS.ProcessEnv,
    });
    expect(loaded.config.server.host).toBe('127.0.0.9');
    expect(loaded.config.server.port).toBe(9000);
    expect(loaded.errors).toEqual([]);
  });

  it('缺少无默认值的环境变量时按空串替换并继续校验', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const dir = join(root, 'missing-env');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'api-server-config.yaml'),
      'logging:\n  level: ${NOT_SET_LEVEL:-info}\n',
      'utf8',
    );
    const loaded = await loadConfig({ cwd: dir, env: {} as NodeJS.ProcessEnv });
    expect(loaded.errors).toEqual([]);
    expect(loaded.config.logging.level).toBe('info');
  });

  it('空串不按 0 处理，数值字段报校验错误', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const dir = join(root, 'empty-number');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'api-server-config.yaml'), 'server:\n  port: ${NOT_SET_PORT}\n', 'utf8');
    const loaded = await loadConfig({ cwd: dir, env: {} as NodeJS.ProcessEnv });
    expect(loaded.errors.join('\n')).toContain('CLI_CONFIG_INVALID');
    expect(loaded.config.server.port).toBe(7860);
  });

  it('缺少无默认值的路径变量时替换为空串并按字段报错', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const dir = join(root, 'missing-env-path');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'api-server-config.yaml'), 'logging:\n  dir: ${NOT_SET_DIR}\n', 'utf8');
    const loaded = await loadConfig({ cwd: dir, env: {} as NodeJS.ProcessEnv });
    expect(loaded.errors.join('\n')).toContain('CLI_CONFIG_INVALID');
  });

  it('未知字段报错', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const dir = join(root, 'unknown');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'api-server-config.yaml'), 'server:\n  unknownKey: 1\n', 'utf8');
    const loaded = await loadConfig({ cwd: dir });
    expect(loaded.errors.length).toBeGreaterThan(0);
    expect(loaded.errors.join('\n')).toContain('CLI_CONFIG_INVALID');
  });

  it('指定配置文件不存在时报错', async () => {
    await expect(
      loadConfig({ cwd: root, configPath: join(root, 'nope.yaml') }),
    ).rejects.toThrow();
  });

  it('作业并发默认不限制，配置文件可设置上限', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const dir = join(root, 'jobs-concurrency');
    await mkdir(dir, { recursive: true });

    const unset = await loadConfig({ cwd: root, env: {} as NodeJS.ProcessEnv });
    expect(unset.config.jobs.maxConcurrentJobs).toBe(0);

    await writeFile(join(dir, 'api-server-config.yaml'), 'jobs:\n  maxConcurrentJobs: 5\n', 'utf8');
    const limited = await loadConfig({ cwd: dir, env: {} as NodeJS.ProcessEnv });
    expect(limited.errors).toEqual([]);
    expect(limited.config.jobs.maxConcurrentJobs).toBe(5);
  });

  it('jobs.maxConcurrentJobs 为负数时报校验错误', async () => {
    const { writeFile, mkdir } = await import('node:fs/promises');
    const dir = join(root, 'jobs-concurrency-invalid');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'api-server-config.yaml'), 'jobs:\n  maxConcurrentJobs: -1\n', 'utf8');
    const loaded = await loadConfig({ cwd: dir, env: {} as NodeJS.ProcessEnv });
    expect(loaded.errors.join('\n')).toContain('CLI_CONFIG_INVALID');
  });
});

describe('generateDefaultConfig', () => {
  it('未指定 --config 且工作区无配置时生成默认配置', async () => {
    const { generateDefaultConfig } = await import('../src/config.js');
    const workDir = join(root, 'ws-generate');
    const loaded = await loadConfig({ cwd: root, workDir, env: {} as NodeJS.ProcessEnv });
    const written = await generateDefaultConfig(loaded);
    expect(written).toBe(join(workDir, 'api-server-config.yaml'));
    const content = await readFile(written!, 'utf8');
    expect(content).toContain('workspace: null');
    expect(content).not.toContain('${OFDRW_VIEWER_API_');
  });

  it('指定 --config 时不生成', async () => {
    const { generateDefaultConfig } = await import('../src/config.js');
    const dir = join(root, 'ws-explicit-config');
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'custom.yaml');
    await writeFile(path, 'server:\n  port: 7904\n', 'utf8');
    const loaded = await loadConfig({ cwd: root, configPath: path, env: {} as NodeJS.ProcessEnv });
    expect(await generateDefaultConfig(loaded)).toBeUndefined();
  });

  it('工作区已有配置文件时不覆盖', async () => {
    const { generateDefaultConfig } = await import('../src/config.js');
    const workDir = join(root, 'ws-existing');
    await mkdir(workDir, { recursive: true });
    await writeFile(join(workDir, 'api-server-config.yaml'), 'server:\n  port: 7905\n', 'utf8');
    const loaded = await loadConfig({ cwd: root, workDir, env: {} as NodeJS.ProcessEnv });
    expect(loaded.configPath).toBe(join(workDir, 'api-server-config.yaml'));
    expect(await generateDefaultConfig(loaded)).toBeUndefined();
  });
});

describe('checkDirectories', () => {
  it('工作区根不存在时报告错误', async () => {
    const loaded = await loadConfig({
      cwd: root,
      workDir: join(root, 'not-created'),
      env: {} as NodeJS.ProcessEnv,
    });
    const errors = await checkDirectories(loaded.config, loaded.workspaceRoot);
    expect(errors.join('\n')).toContain('CLI_CONFIG_WORKDIR');
  });
});

describe('describeConfig', () => {
  it('通过时输出包含工作区与目录', async () => {
    const loaded = await loadConfig({ cwd: root });
    const { text, ok } = describeConfig(loaded);
    expect(ok).toBe(true);
    expect(text).toContain('工作区');
    expect(text).toContain('校验结果: 通过');
  });
});