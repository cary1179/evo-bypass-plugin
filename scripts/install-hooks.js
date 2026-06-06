#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VALID_RUNTIMES = new Set(['claude', 'codex']);
const ENV_TARGET_PATHS = {
  claude: 'EVO_BYPASS_CLAUDE_HOOKS_PATH',
  codex: 'EVO_BYPASS_CODEX_HOOKS_PATH',
};
const DEFAULT_TARGET_PATHS = {
  claude: ['.claude', 'settings.json'],
  codex: ['.codex', 'hooks.json'],
};

export async function installHooks({ runtime, repoRoot, targetPath } = {}) {
  assertRuntime(runtime);

  const resolvedRepoRoot = path.resolve(repoRoot ?? defaultRepoRoot());
  const resolvedTargetPath = path.resolve(
    targetPath ?? process.env[ENV_TARGET_PATHS[runtime]] ?? path.join(os.homedir(), ...DEFAULT_TARGET_PATHS[runtime]),
  );
  const templatePath = path.join(resolvedRepoRoot, 'hooks', `${runtime}-hooks.json`);
  const incoming = replaceCommandsHome(await readJsonFile(templatePath, 'hook template'), resolvedRepoRoot);
  const existing = await readExistingConfig(resolvedTargetPath);
  const merged = mergeHookConfig(existing, incoming);

  await fs.mkdir(path.dirname(resolvedTargetPath), { recursive: true });
  await fs.writeFile(resolvedTargetPath, `${JSON.stringify(merged, null, 2)}\n`);

  return {
    runtime,
    repoRoot: resolvedRepoRoot,
    targetPath: resolvedTargetPath,
  };
}

export function mergeHookConfig(existing, incoming) {
  const merged = cloneConfig(existing ?? {});
  const incomingHooks = incoming?.hooks;
  if (!incomingHooks || typeof incomingHooks !== 'object' || Array.isArray(incomingHooks)) {
    return merged;
  }

  if (!merged.hooks || typeof merged.hooks !== 'object' || Array.isArray(merged.hooks)) {
    merged.hooks = {};
  }

  for (const [eventName, incomingGroups] of Object.entries(incomingHooks)) {
    if (!Array.isArray(incomingGroups)) {
      continue;
    }
    if (!Array.isArray(merged.hooks[eventName])) {
      merged.hooks[eventName] = [];
    }

    for (const incomingGroup of incomingGroups) {
      appendHookGroup(merged.hooks[eventName], incomingGroup);
    }
  }

  return merged;
}

async function readExistingConfig(targetPath) {
  try {
    return await readJsonFile(targetPath, 'existing hook config');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

async function readJsonFile(filePath, label) {
  const contents = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(contents);
  } catch (error) {
    const wrapped = new Error(`Invalid JSON in ${label} at ${filePath}: ${error.message}`);
    wrapped.cause = error;
    throw wrapped;
  }
}

function appendHookGroup(existingGroups, incomingGroup) {
  if (!incomingGroup || typeof incomingGroup !== 'object' || Array.isArray(incomingGroup)) {
    return;
  }

  const incomingCommands = new Set(commandKeysForGroups([incomingGroup]));
  const existingCommands = new Set(commandKeysForGroups(existingGroups));
  const seenCommands = new Set(existingCommands);
  const missingHooks = [];
  if (Array.isArray(incomingGroup.hooks)) {
    for (const hook of incomingGroup.hooks) {
      if (typeof hook?.command === 'string') {
        const commandKey = commandIdentity(hook.command);
        if (seenCommands.has(commandKey)) {
          refreshExistingHook(existingGroups, hook);
          continue;
        }
        seenCommands.add(commandKey);
      }
      missingHooks.push(hook);
    }
  }

  if (missingHooks.length === 0 && incomingCommands.size > 0) {
    return;
  }

  const targetGroup = findCompatibleGroup(existingGroups, incomingGroup);
  if (targetGroup) {
    if (!Array.isArray(targetGroup.hooks)) {
      targetGroup.hooks = [];
    }
    targetGroup.hooks.push(...cloneConfig(missingHooks));
    return;
  }

  const groupToAppend = cloneConfig(incomingGroup);
  if (incomingCommands.size > 0) {
    groupToAppend.hooks = cloneConfig(missingHooks);
  }
  if (!Array.isArray(groupToAppend.hooks) || groupToAppend.hooks.length > 0) {
    existingGroups.push(groupToAppend);
  }
}

function refreshExistingHook(existingGroups, incomingHook) {
  const incomingKey = commandIdentity(incomingHook.command);
  for (const group of existingGroups) {
    if (!Array.isArray(group?.hooks)) {
      continue;
    }
    const index = group.hooks.findIndex((hook) => commandIdentity(hook?.command) === incomingKey);
    if (index >= 0) {
      group.hooks[index] = cloneConfig(incomingHook);
      return;
    }
  }
}

function findCompatibleGroup(existingGroups, incomingGroup) {
  return existingGroups.find((existingGroup) => {
    if (!existingGroup || typeof existingGroup !== 'object' || Array.isArray(existingGroup)) {
      return false;
    }
    return existingGroup.matcher === incomingGroup.matcher;
  });
}

function commandKeysForGroups(groups) {
  const commands = [];
  for (const group of groups) {
    if (!Array.isArray(group?.hooks)) {
      continue;
    }
    for (const hook of group.hooks) {
      if (typeof hook?.command === 'string') {
        commands.push(commandIdentity(hook.command));
      }
    }
  }
  return commands;
}

function commandIdentity(command) {
  if (typeof command !== 'string') {
    return '';
  }
  const withoutLegacySessionArg = command.replace(/\s+["']?\$CLAUDE_SESSION_ID["']?$/, '');
  const normalizedScript = withoutLegacySessionArg.replace(/\/scripts\/review-session\.js/g, '/scripts/enqueue-review-job.js');
  if (normalizedScript.includes('/scripts/enqueue-review-job.js') && !/\s--runtime\s+/.test(normalizedScript)) {
    return `${normalizedScript} --runtime claude`;
  }
  return normalizedScript;
}

function replaceCommandsHome(value, repoRoot) {
  if (typeof value === 'string') {
    return value.replaceAll('$EVO_BYPASS_HOME', repoRoot);
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceCommandsHome(item, repoRoot));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceCommandsHome(item, repoRoot)]),
    );
  }
  return value;
}

function cloneConfig(value) {
  return structuredClone(value);
}

function assertRuntime(runtime) {
  if (!VALID_RUNTIMES.has(runtime)) {
    throw new Error('Expected --runtime claude|codex');
  }
}

function defaultRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function parseCliArgs(argv) {
  const runtimeIndex = argv.indexOf('--runtime');
  return {
    runtime: runtimeIndex >= 0 ? argv[runtimeIndex + 1] : undefined,
  };
}

async function main() {
  const result = await installHooks(parseCliArgs(process.argv.slice(2)));
  console.log(`Installed ${result.runtime} hooks to ${result.targetPath}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
