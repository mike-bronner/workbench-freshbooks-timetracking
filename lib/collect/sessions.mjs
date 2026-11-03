import { createReadStream, readdirSync, statSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';

const MESSAGE_TYPES = new Set(['user', 'assistant']);

const entries = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
};

export function transcriptFiles(projectsDir, sinceMs) {
  const files = [];
  const keep = (path) => statSync(path).mtimeMs >= sinceMs && files.push(path);
  for (const project of entries(projectsDir).filter((e) => e.isDirectory())) {
    const projectDir = join(projectsDir, project.name);
    for (const entry of entries(projectDir)) {
      const path = join(projectDir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.jsonl')) keep(path);
      if (entry.isDirectory()) {
        for (const agent of entries(join(path, 'subagents'))) {
          if (agent.isFile() && /^agent-.*\.jsonl$/.test(agent.name)) keep(join(path, 'subagents', agent.name));
        }
      }
    }
  }
  return files.sort();
}

const stripReminders = (text) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');

export const promptText = (message) => {
  const content = message?.content;
  if (typeof content === 'string') return stripReminders(content);
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => stripReminders(b.text)).join('\n');
};

export async function readTranscript(path, seen = new Set()) {
  const agents = new Map();
  const fileAgent = basename(path).startsWith('agent-') ? basename(path, '.jsonl').slice('agent-'.length) : 'main';
  const lines = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  let cwd = null;
  let branch = null;
  for await (const line of lines) {
    if (!line.includes('"timestamp"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!MESSAGE_TYPES.has(entry.type) || typeof entry.timestamp !== 'string') continue;
    const t = Date.parse(entry.timestamp);
    if (Number.isNaN(t)) continue;
    if (entry.uuid) {
      if (seen.has(entry.uuid)) continue;
      seen.add(entry.uuid);
    }
    cwd = entry.cwd || cwd;
    branch = entry.gitBranch ?? branch;
    const agentId = entry.isSidechain && entry.agentId && fileAgent === 'main' ? entry.agentId : fileAgent;
    const sessionId = entry.sessionId || basename(path, '.jsonl');
    const key = `${sessionId}:${agentId}`;
    if (!agents.has(key)) agents.set(key, { key, sessionId, agentId, points: [], prompts: [] });
    const agent = agents.get(key);
    agent.points.push({ t, cwd, branch: branch || null });
    if (entry.type === 'user' && !entry.isMeta) {
      const text = promptText(entry.message);
      if (text.trim()) agent.prompts.push(text);
    }
  }
  return [...agents.values()];
}

export async function scanSessions(projectsDir, sinceMs) {
  if (!existsSync(projectsDir)) throw new Error(`sessions: ${projectsDir} does not exist`);
  const seen = new Set();
  const agents = [];
  for (const file of transcriptFiles(projectsDir, sinceMs)) agents.push(...await readTranscript(file, seen));
  for (const agent of agents) agent.points.sort((a, b) => a.t - b.t);
  return agents;
}
