import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sandbox } from './lib/fixtures.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHECK = join(ROOT, 'scripts', 'check-skills.sh');
const GOOD = '---\nname: estimate\ndescription: Estimate hours.\n---\n\nRun `bash "${CLAUDE_PLUGIN_ROOT}/bin/plan.sh"`.\n';

describe('skill check', () => {
  let box;

  beforeEach(() => {
    box = sandbox();
    mkdirSync(join(box.root, 'bin'));
    writeFileSync(join(box.root, 'bin', 'plan.sh'), '');
  });

  afterEach(() => box.cleanup());

  const check = (text, name = 'estimate') => {
    mkdirSync(join(box.root, 'skills', name), { recursive: true });
    writeFileSync(join(box.root, 'skills', name, 'SKILL.md'), text);
    const result = spawnSync('bash', [CHECK, box.root], { encoding: 'utf8' });
    return { code: result.status, err: result.stderr };
  };

  it('passes the skills of this plugin', () => {
    assert.equal(spawnSync('bash', [CHECK, ROOT], { encoding: 'utf8' }).status, 0);
  });

  it('passes a well-formed skill', () => {
    assert.deepEqual(check(GOOD), { code: 0, err: '' });
  });

  it('fails frontmatter with no closing line, even when the body names the skill', () => {
    const { code, err } = check('---\nname: estimate\ndescription: Estimate hours.\n\nRun `bash "${CLAUDE_PLUGIN_ROOT}/bin/plan.sh"`.\n');
    assert.equal(code, 1);
    assert.match(err, /frontmatter must open on line 1 with --- and close with ---/);
  });

  it('fails frontmatter that does not open on line 1', () => {
    const { code, err } = check(`\n${GOOD}`);
    assert.equal(code, 1);
    assert.match(err, /frontmatter must open on line 1/);
  });

  it('fails a name that is not the folder, and a missing description', () => {
    assert.match(check(GOOD.replace('name: estimate', 'name: estimates')).err, /frontmatter name must be estimate/);
    assert.match(check(GOOD.replace('description: Estimate hours.\n', '')).err, /frontmatter needs a description/);
  });

  it('fails a script reached from a checkout, or a script that does not exist', () => {
    assert.match(check(`${GOOD}\nRun bin/plan.sh.\n`).err, /bin\/plan\.sh must be reached as \$\{CLAUDE_PLUGIN_ROOT\}/);
    assert.match(check(`${GOOD}\nRun "\${CLAUDE_PLUGIN_ROOT}/bin/nope.sh".\n`).err, /nope\.sh names no script in bin\//);
  });
});
