#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const store = process.env.WBFT_FAKE_KEYCHAIN;
const args = process.argv.slice(2);
appendFileSync(`${store}.argv`, `${JSON.stringify(args)}\n`);
const items = existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : {};
const opt = (list, flag) => list[list.indexOf(flag) + 1];

if (args[0] === 'find-generic-password') {
  const value = items[`${opt(args, '-s')}/${opt(args, '-a')}`];
  if (value === undefined) {
    process.stderr.write('security: The specified item could not be found in the keychain.\n');
    process.exit(44);
  }
  process.stdout.write(`${value}\n`);
} else if (args[0] === '-i') {
  for (const line of readFileSync(0, 'utf8').split('\n').filter(Boolean)) {
    const words = line.split(/\s+/);
    if (words[0] !== 'add-generic-password' || !words.includes('-U')) process.exit(1);
    if (process.env.WBFT_FAKE_KEYCHAIN_DROP_WRITES) continue;
    items[`${opt(words, '-s')}/${opt(words, '-a')}`] = Buffer.from(opt(words, '-X'), 'hex').toString('utf8');
  }
  writeFileSync(store, JSON.stringify(items));
} else {
  process.exit(2);
}
