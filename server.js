'use strict';

/**
 * HUEVO.SU — static website for Bothost / Node.js 18+.
 * Uses the hosting provider's PORT. Handles EADDRINUSE without a Node crash,
 * retries temporary conflicts and recognises another running copy of itself.
 * Important: a different process permanently occupying PORT must be stopped;
 * silently switching ports would break Bothost's reverse proxy.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.resolve(__dirname, 'public');
const portValue = process.env.PORT || '3000';
const PORT = Number(portValue);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_RETRIES = Math.min(20, Math.max(0, Number(process.env.START_RETRY_COUNT ?? 10) || 0));
const RETRY_MS = Math.min(5000, Math.max(100, Number(process.env.START_RETRY_MS ?? 1500) || 1500));

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[HUEVO] Недопустимый порт: ${portValue}`);
  process.exit(1);
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8'
};

function respond(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  // A lightweight marker helps detect a second copy of this *same* website.
  if (pathname === '/__huevo_health') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Huevo-Test': '1'
    });
    return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ app: 'huevo-test', status: 'ok' }));
  }

  if (pathname === '/') pathname = '/index.html';
  const target = path.resolve(publicDir, '.' + pathname);
  if (target !== publicDir && !target.startsWith(publicDir + path.sep)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  fs.stat(target, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 | Не найдено');
    }

    res.writeHead(200, {
      'Content-Type': mime[path.extname(target).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'SAMEORIGIN',
      'X-Huevo-Test': '1'
    });
    if (req.method === 'HEAD') return res.end();

    const file = fs.createReadStream(target);
    file.on('error', () => {
      if (res.headersSent) res.destroy();
      else { res.writeHead(500); res.end('Internal server error'); }
    });
    file.pipe(res);
  });
}

const server = http.createServer(respond);
let attempts = 0;
let stopped = false;

// If another instance of THIS SAME app is running, avoid a Node stack trace.
// A different server on this port is not safe to ignore.
function findExistingHuevoServer() {
  return new Promise(resolve => {
    const req = http.get({ hostname: '127.0.0.1', port: PORT, path: '/__huevo_health', timeout: 750 }, res => {
      const isSame = res.statusCode === 200 && res.headers['x-huevo-test'] === '1';
      res.resume();
      resolve(isSame);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

function start() {
  if (stopped) return;
  try {
    server.listen(PORT, HOST);
  } catch (err) {
    console.error('[HUEVO] Ошибка запуска:', err.message);
    process.exitCode = 1;
  }
}

server.on('listening', () => {
  console.log(`[HUEVO] Сайт работает: http://${HOST}:${PORT}`);
});

server.on('error', async err => {
  if (err.code !== 'EADDRINUSE') {
    console.error('[HUEVO] Ошибка сервера:', err.message);
    stopped = true;
    process.exitCode = 1;
    return;
  }

  if (await findExistingHuevoServer()) {
    console.log(`[HUEVO] На порту ${PORT} уже работает другая копия HUEVO Test. Второй экземпляр не нужен.`);
    stopped = true;
    return;
  }

  if (attempts++ < MAX_RETRIES) {
    console.warn(`[HUEVO] Порт ${PORT} занят. Повторная попытка ${attempts}/${MAX_RETRIES}...`);
    setTimeout(start, RETRY_MS);
    return;
  }

  console.error(`[HUEVO] Не удалось запуститься: порт ${PORT} занят ДРУГИМ процессом.`);
  console.error('[HUEVO] Нельзя автоматически изменить порт: у Bothost прокси направлен на порт из настроек.');
  console.error('[HUEVO] Убедитесь, что для проекта выключен лишний HTTP-сервер / повторный запуск.');
  stopped = true;
  process.exitCode = 1;
});

process.on('SIGTERM', () => {
  stopped = true;
  if (server.listening) server.close();
});
process.on('SIGINT', () => {
  stopped = true;
  if (server.listening) server.close();
});

start();
