import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function readOptions(args) {
  let preview = false;
  let port;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--preview') preview = true;
    else if (argument === '--port') {
      port = args[++index];
      if (port === undefined) throw new Error('--port requires a value.');
    }
    else if (argument.startsWith('--port=')) port = argument.slice(7);
    else throw new Error(`Unknown option: ${argument}`);
  }
  if (port === undefined) port = preview ? 4173 : 5173;
  if (!/^\d+$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('--port must be an integer from 1 to 65535.');
  }
  return { preview, port: Number(port) };
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function respond(response, code, message) {
  response.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end(`${message}\n`);
}

async function start() {
  const options = readOptions(process.argv.slice(2));
  const root = await realpath(options.preview ? path.join(projectRoot, 'dist') : projectRoot);
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      respond(response, 405, 'Method not allowed');
      return;
    }
    let pathname;
    try {
      // Inspect the original path: URL() would normalize literal ../ segments.
      pathname = decodeURIComponent((request.url || '/').split('?')[0]);
    } catch {
      respond(response, 400, 'Malformed URL encoding');
      return;
    }
    if (!pathname.startsWith('/') || /[\\\0]/.test(pathname) || pathname.split('/').some(part => part.startsWith('.'))) {
      respond(response, 403, 'Forbidden path');
      return;
    }
    const candidate = path.resolve(root, `.${pathname}`);
    if (!isWithin(root, candidate)) {
      respond(response, 403, 'Forbidden path');
      return;
    }
    try {
      let file;
      try {
        file = await realpath(candidate);
      } catch (error) {
        if (options.preview || !['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
        // Match the build's public/ -> site-root asset mapping during development.
        file = await realpath(path.resolve(root, 'public', `.${pathname}`));
      }
      if (!isWithin(root, file)) {
        respond(response, 403, 'Forbidden path');
        return;
      }
      let metadata = await stat(file);
      if (metadata.isDirectory()) {
        file = await realpath(path.join(file, 'index.html'));
        if (!isWithin(root, file)) {
          respond(response, 403, 'Forbidden path');
          return;
        }
        metadata = await stat(file);
      }
      if (!metadata.isFile()) {
        respond(response, 404, 'Not found');
        return;
      }
      response.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Length': metadata.size,
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      const stream = createReadStream(file);
      stream.on('error', () => response.destroy());
      response.on('close', () => stream.destroy());
      stream.pipe(response);
    } catch (error) {
      respond(response, error.code === 'EACCES' ? 403 : 404, error.code === 'EACCES' ? 'Forbidden path' : 'Not found');
    }
  });
  server.on('error', error => {
    console.error(`Server failed: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(options.port, '127.0.0.1', () => {
    console.log(`Context Atlas ${options.preview ? 'preview' : 'dev'}: http://127.0.0.1:${options.port}`);
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}

start().catch(error => {
  console.error(`Server failed: ${error.code === 'ENOENT' ? 'Run npm run build before previewing.' : error.message}`);
  process.exitCode = 1;
});
