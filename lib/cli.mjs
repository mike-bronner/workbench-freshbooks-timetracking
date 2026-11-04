import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { lookupRefs, searchPullRequests, searchRepoPullRequests } from './collect/github.mjs';
import { createResolver } from './collect/resolve.mjs';
import { scanSessions } from './collect/sessions.mjs';
import { REPO, defaultConfigPath, loadConfig } from './config.mjs';
import { branchIndexOf, buildRange, estimate, repoChoices } from './estimate.mjs';
import { reviewTable } from './table.mjs';
import { isDate } from './time.mjs';

const USAGE = `usage: cli.mjs <repos|estimate> --from YYYY-MM-DD --to YYYY-MM-DD
  [--repo owner/name ...] [--format json|table] [--config path] [--projects-dir path]`;

class UsageError extends Error {}

function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        from: { type: 'string' },
        to: { type: 'string' },
        repo: { type: 'string', multiple: true },
        format: { type: 'string', default: 'json' },
        config: { type: 'string' },
        'projects-dir': { type: 'string' },
      },
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const { values, positionals } = parsed;
  const [command] = positionals;
  if (positionals.length !== 1 || !['repos', 'estimate'].includes(command)) throw new UsageError('expected one command: repos or estimate');
  if (!isDate(values.from) || !isDate(values.to)) throw new UsageError('--from and --to must be dates as YYYY-MM-DD');
  if (values.from > values.to) throw new UsageError('--from must not be after --to');
  if (!['json', 'table'].includes(values.format)) throw new UsageError('--format must be json or table');
  if (command === 'repos' && values.format === 'table') throw new UsageError('repos prints JSON only');
  const repos = values.repo ?? null;
  if (repos && !repos.every((r) => REPO.test(r))) throw new UsageError('--repo must look like owner/name');
  return { command, ...values, repos };
}

export async function run(argv, { gh } = {}) {
  const options = parse(argv);
  const config = loadConfig(options.config ?? defaultConfigPath());
  const range = buildRange(options.from, options.to, config.timezone);
  const projectsDir = options['projects-dir'] ?? join(homedir(), '.claude', 'projects');
  const agents = await scanSessions(projectsDir, range.startMs);
  const prs = searchPullRequests({ authors: config.authors, from: options.from, to: options.to }, gh);
  const resolveRepo = createResolver({ projectsDir, knownRepos: prs.map((p) => p.repo), branchIndex: branchIndexOf(prs) });
  const result = estimate({
    agents, prs, resolveRepo, config, range,
    repos: options.command === 'estimate' ? options.repos : null,
    lookupRefs: (refs) => lookupRefs(refs, gh),
    lookupCommits: options.command === 'estimate' ? (repos) => searchRepoPullRequests({ repos, from: options.from, to: options.to }, gh) : undefined,
  });
  if (options.command === 'repos') return `${JSON.stringify(repoChoices(result), null, 2)}\n`;
  return options.format === 'table' ? reviewTable(result) : `${JSON.stringify(result, null, 2)}\n`;
}

const main = async () => {
  try {
    process.stdout.write(await run(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    if (error instanceof UsageError) process.stderr.write(`${USAGE}\n`);
    process.exit(error instanceof UsageError ? 2 : 1);
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
