import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

test('all browser modules parse before the site can be published', () => {
  const directory = new URL('../../src/EtymoVocab.Web/wwwroot/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.js'))) {
    execFileSync(process.execPath, ['--check', fileURLToPath(new URL(name, directory))], { encoding: 'utf8' });
  }
});
