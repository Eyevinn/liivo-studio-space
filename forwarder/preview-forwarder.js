'use strict';
// Preview forwarder for the Liivo Studio workspace block. Listens on 0.0.0.0:PORT
// (the only non-loopback listener in the instance) and forwards HTTP requests and
// WebSocket upgrades to the project's preview on 127.0.0.1:PREVIEW_PORT.
// node:http and node:net only, no dependencies.
const http = require('node:http');
const net = require('node:net');

const RESERVED_PREFIX = '/__liivo/';
const OPEN_PATH = '/__liivo/open';

const PAGE_502 =
  '<!doctype html><html><head><meta charset="utf-8"><title>Preview not running</title></head>' +
  "<body><h1>Preview not running</h1><p>The project's preview is not running.</p></body></html>\n";

function pathOf(url) {
  const i = url.search(/[?#]/);
  return i === -1 ? url : url.slice(0, i);
}

function isReserved(url) {
  return pathOf(url).startsWith(RESERVED_PREFIX);
}

function createForwarder({ previewPort, upstreamHost = '127.0.0.1' }) {
  const server = http.createServer((req, res) => {
    const path = pathOf(req.url);
    if (path === OPEN_PATH) {
      res.writeHead(302, { Location: '/', 'Content-Length': '0' });
      res.end();
      req.resume();
      return;
    }
    if (isReserved(req.url)) {
      res.writeHead(404, { 'Content-Type': 'text/plain', 'Content-Length': '10' });
      res.end('Not found\n');
      req.resume();
      return;
    }
    const upstream = http.request(
      {
        host: upstreamHost,
        port: previewPort,
        method: req.method,
        path: req.url,
        headers: req.headers,
        agent: false,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode, upRes.statusMessage, upRes.headers);
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
      }
    );
    upstream.on('error', () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(PAGE_502),
      });
      res.end(PAGE_502);
    });
    res.on('close', () => upstream.destroy());
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    if (isReserved(req.url)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    const upstream = net.connect(previewPort, upstreamHost);
    upstream.on('error', () => {
      if (socket.writable) {
        socket.end(
          'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Type: text/html; charset=utf-8\r\n' +
            `Content-Length: ${Buffer.byteLength(PAGE_502)}\r\n\r\n${PAGE_502}`
        );
      } else {
        socket.destroy();
      }
    });
    upstream.on('connect', () => {
      let rawHead = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        rawHead += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
      }
      upstream.write(`${rawHead}\r\n`);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });

  server.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  return server;
}

function parsePort(name, value) {
  if (!/^[0-9]+$/.test(value || '')) throw new Error(`${name} must be a number, got '${value}'`);
  const n = Number(value);
  if (n < 1 || n > 65535) throw new Error(`${name} out of range: ${value}`);
  return n;
}

if (require.main === module) {
  try {
    const port = parsePort('PORT', process.env.PORT);
    const previewPort = parsePort('PREVIEW_PORT', process.env.PREVIEW_PORT || '3000');
    // An unexpected error must never take the forwarder down.
    process.on('uncaughtException', (e) => console.error(`preview-forwarder: ${e.message}`));
    createForwarder({ previewPort }).listen(port, '0.0.0.0', () => {
      console.error(`preview-forwarder: 0.0.0.0:${port} -> 127.0.0.1:${previewPort}`);
    });
  } catch (e) {
    console.error(`preview-forwarder: ${e.message}`);
    process.exit(2);
  }
}

module.exports = { createForwarder };
