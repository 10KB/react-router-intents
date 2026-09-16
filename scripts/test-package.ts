import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const consumer = mkdtempSync(join(tmpdir(), 'react-router-intents-consumer-'));
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run this check through npm run test:package');
const npm = (args: string[], cwd: string) =>
  execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8' });

try {
  const packed: unknown = JSON.parse(
    npm(['pack', '--ignore-scripts', '--json', '--pack-destination', consumer], packageRoot)
  );
  assert(Array.isArray(packed) && packed.length === 1);
  const [archive] = packed;
  assert(typeof archive.filename === 'string' && Array.isArray(archive.files));
  const publishedFiles = archive.files.map((file: { path: string }) => file.path);
  for (const required of ['dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE']) {
    assert(publishedFiles.includes(required), `Missing published file: ${required}`);
  }
  assert(
    publishedFiles.every((file: string) =>
      /^(dist\/|src\/|package.json$|README.md$|LICENSE$)/.test(file)
    )
  );

  const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(packageRoot, 'package-lock.json'), 'utf8'));
  const version = (name: string): string => {
    const value: unknown = lock.packages[`node_modules/${name}`]?.version;
    assert(typeof value === 'string', `Missing locked version for ${name}`);
    return value;
  };
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'isolated-intents-consumer',
        private: true,
        type: 'module',
        dependencies: {
          [manifest.name]: `file:${join(consumer, archive.filename)}`,
          react: version('react'),
          'react-dom': version('react-dom'),
          'react-router': version('react-router'),
        },
        devDependencies: {
          typescript: version('typescript'),
          '@types/react': version('@types/react'),
          '@types/node': version('@types/node'),
        },
      },
      null,
      2
    )
  );
  npm(['install', '--ignore-scripts', '--no-audit', '--no-fund'], consumer);
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022', 'DOM', 'DOM.Iterable'],
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ['node', 'react'],
      },
      include: ['consumer.ts'],
    })
  );
  writeFileSync(
    join(consumer, 'consumer.ts'),
    `
import assert from 'node:assert/strict';
import { createActionFactory, createActions, defaultActionTransport, ActionRequestError } from 'react-router-intents';
import type { ActionTransport } from 'react-router-intents';
import { useActionData } from 'react-router';

const transport: ActionTransport = defaultActionTransport;
assert.equal(typeof transport.encode, 'function');
assert(new ActionRequestError() instanceof Error);
assert.equal(typeof createActions, 'function');
const configured = createActionFactory<string[]>({ mapError: () => ['invalid'] });
const actions = configured<{ id: string }>()({
  save: { handler: (params, body: { name: string }) => ({ id: params.id, name: body.name }) },
});
type Result = NonNullable<ReturnType<typeof useActionData<typeof actions.action>>>;
function verifyPublicTypes(result: Result) {
  if (result.success) {
    const name: string = result.data.name;
    // @ts-expect-error Published declarations must preserve the result type.
    const invalid: number = result.data.name;
    return name;
  }
  return result.errors.join(',');
}
const result = await actions.action({
  params: { id: '123' }, context: {}, url: new URL('http://localhost/save'), pattern: '/save',
  request: new Request('http://localhost/save', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ intent: 'save', body: { name: 'Published package' } }),
  }),
});
assert(!(result instanceof Response));
assert.equal(verifyPublicTypes(result), 'Published package');
assert.deepEqual(result, { type: 'action-result', intent: 'save', success: true, data: { id: '123', name: 'Published package' } });
`
  );
  npm(['exec', '--', 'tsc', '-p', 'tsconfig.json'], consumer);
  execFileSync(process.execPath, ['--experimental-strip-types', 'consumer.ts'], {
    cwd: consumer,
    stdio: 'inherit',
  });
  console.log(
    'Packed package: runtime exports and published types verified in an isolated npm consumer.'
  );
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
