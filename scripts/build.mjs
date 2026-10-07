// Production build: the shell (Vite) into dist/shell, and the server (esbuild) into dist/server.
// Each app's server part becomes its own file, imported only when a team turns the app on.
import { build as vite } from 'vite';
import { build as esbuild } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
await vite({ configFile: path.join(root, 'apps/shell/vite.config.ts'), logLevel: 'warn' });
console.log('shell built into dist/shell');

const entryPoints = { main: path.join(root, 'apps/server/main.ts'), http: path.join(root, 'core/http.ts'), vercel: path.join(root, 'core/vercel.ts') };
for (const d of fs.readdirSync(path.join(root, 'apps-builtin'))) {
  const f = path.join(root, 'apps-builtin', d, 'server.ts');
  if (fs.existsSync(f)) entryPoints[`apps/${d}`] = f;
}
fs.rmSync(path.join(root, 'dist/server'), { recursive: true, force: true });
// One build with shared chunks, so the core and every app share one copy of each module.
await esbuild({
  entryPoints,
  outdir: path.join(root, 'dist/server'),
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  packages: 'external',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log('server built into dist/server');

// Mounted apps copied into vendor/ (scripts/vendor.mjs) need their own dependencies.
for (const d of fs.existsSync(path.join(root, 'vendor')) ? fs.readdirSync(path.join(root, 'vendor')) : []) {
  const dir = path.join(root, 'vendor', d);
  if (fs.existsSync(path.join(dir, 'package.json')) && !fs.existsSync(path.join(dir, 'node_modules'))) {
    const { execSync } = await import('node:child_process');
    execSync('npm install --omit=dev --ignore-scripts --no-audit --no-fund', { cwd: dir, stdio: 'inherit' });
    console.log(`installed vendor/${d}`);
  }
}
