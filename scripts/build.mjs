import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(projectRoot, 'dist');

try {
  // Verify the entry point before removing the previous successful build.
  if (!(await stat(path.join(projectRoot, 'index.html'))).isFile()) {
    throw new Error('index.html is not a file.');
  }
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(path.join(projectRoot, 'index.html'), path.join(destination, 'index.html'));
  await cp(path.join(projectRoot, 'src'), path.join(destination, 'src'), { recursive: true });
  // Public assets are served at the site root, including on GitHub Pages.
  for (const name of await readdir(path.join(projectRoot, 'public'))) {
    if (name === 'index.html' || name === 'src') {
      throw new Error(`public/${name} would overwrite application files.`);
    }
    await cp(path.join(projectRoot, 'public', name), path.join(destination, name), { recursive: true });
  }
  console.log(`Built static app: ${destination}`);
} catch (error) {
  console.error(`Build failed: ${error.message}`);
  process.exitCode = 1;
}
