import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

const GITHUB_REMOTE = /github\.com[:/]+([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const SCRATCHPAD = /\/claude-\d+\/(?!\.\.?\/)([^/]+)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/scratchpad(?:\/|$)/;

export const parseGithubRemote = (url) => {
  const m = GITHUB_REMOTE.exec((url ?? '').trim());
  return m ? `${m[1]}/${m[2]}` : null;
};

const defaultGit = (cwd) => {
  try {
    return execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};

const firstCwd = (path) => {
  if (!existsSync(path)) return null;
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(1 << 20);
    const text = buffer.toString('utf8', 0, readSync(fd, buffer, 0, buffer.length, 0));
    const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(text);
    return m ? JSON.parse(m[1]) : null;
  } finally {
    closeSync(fd);
  }
};

export function createResolver({ projectsDir, knownRepos = [], branchIndex = new Map(), git = defaultGit }) {
  const byName = new Map();
  const canonical = new Map(knownRepos.map((repo) => [repo.toLowerCase(), repo]));
  for (const repo of knownRepos) {
    const name = repo.split('/')[1].toLowerCase();
    byName.set(name, [...new Set([...(byName.get(name) ?? []), repo])]);
  }
  const cache = new Map();

  const fromRemote = (cwd, depth) => {
    if (depth > 3 || !cwd || !isAbsolute(cwd) || !existsSync(cwd)) return null;
    const url = git(cwd);
    if (!url) return null;
    return parseGithubRemote(url) ?? (isAbsolute(url) ? fromRemote(url, depth + 1) : null);
  };

  const fromSegments = (cwd) => {
    for (const segment of cwd.split('/').filter(Boolean).reverse()) {
      const matches = byName.get(segment.toLowerCase());
      if (matches) return matches.length === 1 ? matches[0] : null;
    }
    return null;
  };

  const fromScratchpad = (cwd, depth) => {
    const m = SCRATCHPAD.exec(cwd);
    if (!m || depth > 3) return null;
    const parent = firstCwd(join(projectsDir, m[1], `${m[2]}.jsonl`));
    return parent && parent !== cwd ? base(parent, depth + 1) : null;
  };

  const base = (cwd, depth = 0) => {
    if (!cwd) return null;
    if (!cache.has(cwd)) {
      const repo = fromRemote(cwd, depth) ?? (existsSync(cwd) ? null : fromSegments(cwd)) ?? fromScratchpad(cwd, depth);
      cache.set(cwd, repo && (canonical.get(repo.toLowerCase()) ?? repo));
    }
    return cache.get(cwd);
  };

  return (cwd, branch) => {
    const repo = base(cwd);
    if (repo) return repo;
    const candidates = branch ? branchIndex.get(branch) : null;
    return candidates?.size === 1 ? [...candidates][0] : null;
  };
}
