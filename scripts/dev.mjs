/**
 * scripts/dev.mjs — 一键起两个进程（Vite 前端 + Node API 服务）
 * 不引入 concurrently，少一个依赖就少一个装不上的风险。
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

const procs = [];

function run(name, cmd, args, color) {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (stream) => {
    stream.setEncoding('utf8');
    let buf = '';
    stream.on('data', (d) => {
      buf += d;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) console.log(prefix + l);
    });
  };
  pipe(p.stdout);
  pipe(p.stderr);
  p.on('exit', (code) => {
    console.log(prefix + `进程退出，code=${code}`);
    shutdown(code ?? 0);
  });
  procs.push(p);
  return p;
}

function shutdown(code = 0) {
  for (const p of procs) {
    if (!p.killed) p.kill('SIGTERM');
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const nodeBin = process.execPath;
const npm = process.platform === 'win32' ? 'npx.cmd' : 'npx';

run('api', nodeBin, ['server/index.mjs'], '35');
run('web', npm, ['vite', '--host', '127.0.0.1'], '36');

console.log('\n  ▸ 前端  http://127.0.0.1:5173');
console.log('  ▸ 接口  http://127.0.0.1:8787/api/health\n');
