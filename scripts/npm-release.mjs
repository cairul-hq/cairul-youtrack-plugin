import { error as logError, log } from 'node:console';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { argv, env } from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const root = fileURLToPath(new URL('../', import.meta.url));
const registry = 'https://registry.npmjs.org';
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const validName = /^@cairul\/[a-z0-9-]+$/;
const validVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function checkCatalog() {
  const config = readJson(join(root, 'release-please-config.json'));
  const manifest = readJson(join(root, '.release-please-manifest.json'));
  const paths = ['.'];
  const packages = paths.flatMap((path) => {
    let pkg;
    try {
      pkg = readJson(join(root, path, 'package.json'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    if (pkg.private || !validName.test(pkg.name)) return [];
    const component = config.packages[path]?.component;
    if (
      component !== pkg.name.slice('@cairul/'.length) ||
      manifest[path] !== pkg.version ||
      !validVersion.test(pkg.version)
    ) {
      throw new Error('Release Please component or version does not match ' + path + '/package.json.');
    }
    return [{ path, component, name: pkg.name, version: pkg.version, package: pkg }];
  });
  const expected = packages
    .map(({ path }) => path)
    .sort()
    .join('\n');
  if ([Object.keys(config.packages), Object.keys(manifest)].some((paths) => paths.sort().join('\n') !== expected)) {
    throw new Error('Release Please must list exactly the publishable plugin.');
  }
  if (new Set(packages.map((pkg) => pkg.name)).size !== packages.length)
    throw new Error('Duplicate release package names.');
  return packages;
}

function inDependencyOrder(packages) {
  const pending = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const ordered = [];
  while (pending.size) {
    const ready = [...pending.values()].filter(({ package: pkg }) =>
      Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }).every((dependency) => !pending.has(dependency))
    );
    if (!ready.length) throw new Error('The released packages have a circular runtime dependency.');
    for (const pkg of ready) {
      ordered.push(pkg);
      pending.delete(pkg.name);
    }
  }
  return ordered;
}

function pack(directory, all) {
  const catalog = checkCatalog();
  const tags = all
    ? undefined
    : new Set(
        execFileSync('git', ['tag', '--points-at', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/)
      );
  const released = catalog.filter(({ component, version }) => !tags || tags.has(component + '-v' + version));
  if (!released.length) throw new Error('No Release Please package tags point at the CI-verified commit.');

  mkdirSync(directory, { recursive: true });
  const workspace = new Map(catalog.map(({ name, version }) => [name, version]));
  const archives = inDependencyOrder(released).map(({ path, name, version, package: pkg }) => {
    const output = execFileSync(
      'pnpm',
      ['--dir', join(root, path), 'pack', '--pack-destination', directory, '--json'],
      {
        cwd: root,
        encoding: 'utf8',
      }
    );
    const archive = JSON.parse(output);
    if (archive.name !== name || archive.version !== version || !archive.filename.endsWith('.tgz')) {
      throw new Error('Unexpected package archive for ' + name);
    }
    const dependencies = Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })
      .filter((dependency) => workspace.has(dependency))
      .map((dependency) => ({ name: dependency, version: workspace.get(dependency) }));
    return { name, version, filename: basename(archive.filename), dependencies };
  });
  writeFileSync(join(directory, 'packages.json'), JSON.stringify(archives));
  log('Packed ' + archives.length + ' @cairul packages.');
}

function publish(directory) {
  if (!env.NODE_AUTH_TOKEN) throw new Error('Set the NPM_TOKEN GitHub Actions secret.');
  const access = env.NPM_ACCESS ?? 'public';
  if (!['public', 'restricted'].includes(access)) throw new Error('Set NPM_ACCESS to public or restricted.');
  const archives = readJson(join(directory, 'packages.json'));
  const selected = new Set(archives.map(({ name }) => name));
  const prerequisites = new Map();
  for (const { name, version, filename, dependencies } of archives) {
    if (
      !validName.test(name) ||
      !validVersion.test(version) ||
      basename(filename) !== filename ||
      !filename.endsWith('.tgz')
    ) {
      throw new Error('Invalid package metadata in the publish plan.');
    }
    for (const dependency of dependencies) {
      if (!validName.test(dependency.name) || !validVersion.test(dependency.version)) {
        throw new Error('Invalid workspace dependency metadata in the publish plan.');
      }
      if (!selected.has(dependency.name)) prerequisites.set(dependency.name, dependency.version);
    }
  }
  for (const [name, version] of prerequisites) {
    if (!published(directory, name, version))
      throw new Error('Publish the required workspace dependency before this release: ' + name + '@' + version);
  }
  for (const { name, version, filename } of archives) {
    if (published(directory, name, version)) {
      log(name + '@' + version + ' is already published.');
      continue;
    }
    execFileSync(
      'npm',
      ['publish', join(directory, filename), '--access', access, '--registry', registry, '--ignore-scripts'],
      { cwd: directory, stdio: 'inherit' }
    );
  }
}

function published(directory, name, version) {
  const spec = name + '@' + version;
  const lookup = spawnSync('npm', ['view', spec, 'version', '--json', '--registry', registry], {
    cwd: directory,
    encoding: 'utf8',
  });
  if (lookup.error) throw lookup.error;
  if (lookup.status === 0) return !!lookup.stdout.trim() && JSON.parse(lookup.stdout) === version;
  if (/\bE404\b/.test(lookup.stderr)) return false;
  throw new Error('Could not check the npm registry for ' + spec + '.');
}

try {
  const [, , command, directory, flag] = argv;
  if (command === 'verify') {
    log('Verified ' + checkCatalog().length + ' Release Please npm packages.');
  } else if (command === 'pack' && directory) {
    pack(resolve(directory), flag === '--all');
  } else if (command === 'publish' && directory) {
    publish(resolve(directory));
  } else {
    throw new Error('Usage: npm-release.mjs verify | pack <directory> [--all] | publish <directory>');
  }
} catch (error) {
  logError(error.message);
  process.exitCode = 1;
}
