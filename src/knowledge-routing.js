import fs from 'node:fs/promises';
import path from 'node:path';

export async function routeKnowledgeTarget({ root = process.cwd(), event, configuredTarget }) {
  if (configuredTarget) {
    return {
      target: configuredTarget,
      target_reason: 'Configured knowledgeTarget in .bypass/config.json.'
    };
  }

  const scopedDir = firstScopedEvidenceDir({ root, paths: event?.paths });
  if (!scopedDir) {
    return {
      target: path.join(root, 'AGENTS.md'),
      target_reason: 'Selected root AGENTS.md because no scoped evidence path was available.'
    };
  }

  const existing = await nearestExistingAgentsFile({ root, scopedDir });
  if (existing) {
    return {
      target: existing,
      target_reason: `Selected nearest existing AGENTS.md for evidence under ${scopedDir || '.'}.`
    };
  }

  return {
    target: path.join(root, scopedDir, 'AGENTS.md'),
    target_reason: `Proposed missing scoped AGENTS.md for evidence under ${scopedDir}.`
  };
}

function firstScopedEvidenceDir({ root, paths }) {
  if (!Array.isArray(paths)) {
    return '';
  }

  for (const item of paths) {
    if (typeof item !== 'string' || item.trim() === '') {
      continue;
    }

    const relative = safeRelativePath({ root, item });
    if (!relative || relative.startsWith('.bypass')) {
      continue;
    }

    const directory = looksLikeFilePath(relative) ? path.dirname(relative) : relative;
    if (directory && directory !== '.') {
      return directory;
    }
  }

  return '';
}

function safeRelativePath({ root, item }) {
  const resolvedRoot = path.resolve(root);
  const resolvedItem = path.resolve(resolvedRoot, item);
  const relative = path.relative(resolvedRoot, resolvedItem);
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return '';
  }
  return relative.split(path.sep).join('/');
}

function looksLikeFilePath(value) {
  return path.basename(value).includes('.');
}

async function nearestExistingAgentsFile({ root, scopedDir }) {
  let current = scopedDir;
  while (true) {
    const candidate = path.join(root, current, 'AGENTS.md');
    if (await fileExists(candidate)) {
      return candidate;
    }

    if (!current || current === '.') {
      return '';
    }

    const parent = path.dirname(current);
    current = parent === current ? '' : parent;
  }
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}
