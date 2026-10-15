const api = Bun.spawn(['bun', '--watch', 'server/index.ts'], { stdout: 'inherit', stderr: 'inherit' });
const ui = Bun.spawn(['bun', 'x', '--no-install', 'vite'], { stdout: 'inherit', stderr: 'inherit' });
function stop() { api.kill(); ui.kill(); process.exit(); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
await Promise.race([api.exited, ui.exited]); stop();
export {};
