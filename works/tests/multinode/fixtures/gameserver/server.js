#!/usr/bin/env node
'use strict';
// Test fixture standing in for a real game-server jar.
//
// It is a real long-lived process with a real HTTP listener on its allocation port
// and a real stdin console, so start/stop/restart/kill/console/logs/stats are
// exercised end to end through Wings. It is NOT a real Minecraft server.

const http = require('http');

const PORT = Number(process.env.SERVER_PORT || 25565) || 25565;
const NAME = process.env.SERVER_NAME || 'server';
const NODE = process.env.JTG_NODE_ID || 'unknown';
const UUID = process.env.SERVER_UUID || 'unknown';
const MEM = process.env.SERVER_MEMORY || '1024';
const BOOT = Date.now();

const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (line) => console.log(`[${stamp()} INFO]: ${line}`);

say(`Starting JTG test game server '${NAME}'`);
say(`Node: ${NODE}`);
say(`Server UUID: ${UUID}`);
say(`Allocated memory: ${MEM}M`);
say('Loading properties');
say('Default game type: SURVIVAL');
say('Preparing level "world"');

const server = http.createServer((req, res) => {
  // A real game server would not log client requests; keep the log clean so the
  // test can assert on real server output only.
  res.writeHead(200, { 'Content-Type': 'text/plain', Connection: 'close' });
  res.end('JTG-TEST-PONG\n');
});

server.on('error', (err) => {
  console.log(`[${stamp()} ERROR]: ${err.message}`);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  say(`Starting Minecraft server on 0.0.0.0:${PORT}`);
  say('Done (12.345s)! For help, type "help"');
});

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  say('Stopping the server');
  server.close(() => {
    say('Saving worlds');
    say('ThreadedAnvilChunkStorage: All chunks are saved');
    process.exit(0);
  });
  // Do not let lingering keep-alive sockets block exit.
  setTimeout(() => process.exit(0), 1500).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    if (line === 'stop') return shutdown();
    if (line === 'list') say('There are 0 of a max of 20 players online:');
    else if (line.startsWith('say')) say(line.slice(3).trim());
    else if (line === 'help') say('/list - /say <message> - /stop');
    else say('WARN: Unknown command. Type "help" for help.');
  }
});
process.stdin.on('end', () => shutdown());
process.stdin.resume();

say(`Uptime tracker active since boot (pid ${process.pid})`);