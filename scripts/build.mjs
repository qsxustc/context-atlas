import { cp, mkdtemp, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(projectRoot, 'dist');
let staging;

try {
  if (!(await stat(path.join(projectRoot, 'index.html'))).isFile()) {
    throw new Error('index.html is not a file.');
  }
  // Prepare the entire build before changing the previous successful output.
  staging = await mkdtemp(path.join(projectRoot, '.context-atlas-build-'));
  await cp(path.join(projectRoot, 'index.html'), path.join(staging, 'index.html'));
  await cp(path.join(projectRoot, 'src'), path.join(staging, 'src'), { recursive: true });
  await cp(path.join(projectRoot, 'assets', 'social-preview.png'), path.join(staging, 'social-preview.png'));
  // Public assets are served at the site root, including on GitHub Pages.
  for (const name of await readdir(path.join(projectRoot, 'public'))) {
    if (name === 'index.html' || name === 'src') {
      throw new Error(`public/${name} would overwrite application files.`);
    }
    await cp(path.join(projectRoot, 'public', name), path.join(staging, name), { recursive: true });
  }
  const previous = `${staging}.previous`;
  let hasPrevious = false;
  try {
    await rename(destination, previous);
    hasPrevious = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  try {
    await rename(staging, destination);
  } catch (error) {
    if (hasPrevious) {
      try {
        await rename(previous, destination);
      } catch (restoreError) {
        throw new Error(`${error.message}; unable to restore dist: ${restoreError.message}. The previous build remains at ${previous}.`);
      }
    }
    throw error;
  }
  staging = undefined;
  if (hasPrevious) await rm(previous, { recursive: true, force: true });
  console.log(`Built static app: ${destination}`);
} catch (error) {
  console.error(`Build failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (staging) {
    try {
      await rm(staging, { recursive: true, force: true });
    } catch (error) {
      console.error(`Unable to remove incomplete build: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
