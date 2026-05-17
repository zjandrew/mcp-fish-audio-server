import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { once } from 'node:events';

const serverPath = resolve('dist/index.js');

if (!existsSync(serverPath)) {
  throw new Error('dist/index.js is missing. Run npm run build before this test.');
}

const child = spawn(process.execPath, [serverPath], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    DEBUG: 'true',
    FISH_API_KEY: 'test-key',
    FISH_MODEL_ID: 's1',
    FISH_REFERENCE_ID: 'test-reference',
    FISH_OUTPUT_FORMAT: 'mp3',
    FISH_STREAMING: 'false',
    FISH_AUTO_PLAY: 'false',
    AUDIO_OUTPUT_DIR: '/tmp/fish-audio-mcp-test-output',
  },
});

let stdoutBuffer = '';
let sawSdkLogOnStderr = false;
const nonJsonLines = [];

child.stdout.on('data', chunk => {
  stdoutBuffer += chunk.toString('utf8');

  while (stdoutBuffer.includes('\n')) {
    const index = stdoutBuffer.indexOf('\n');
    const line = stdoutBuffer.slice(0, index);
    stdoutBuffer = stdoutBuffer.slice(index + 1);

    try {
      JSON.parse(line);
    } catch {
      nonJsonLines.push(line);
    }
  }
});

child.stderr.on('data', chunk => {
  if (chunk.toString('utf8').includes('TTS Request:')) {
    sawSdkLogOnStderr = true;
  }
});

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'stdout-json-test', version: '1.0.0' },
  },
});

send({ jsonrpc: '2.0', method: 'notifications/initialized' });

send({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: {
    name: 'fish_audio_tts',
    arguments: {
      text: 'stdout must stay json',
      format: 'mp3',
      auto_play: false,
      output_path: '/tmp/fish-audio-mcp-test-output/stdout-json-test.mp3',
    },
  },
});

const deadline = setTimeout(() => {
  child.kill('SIGTERM');
}, 5000);

while (!sawSdkLogOnStderr && nonJsonLines.length === 0 && child.exitCode === null) {
  await new Promise(resolveWait => setTimeout(resolveWait, 25));
}

clearTimeout(deadline);
child.kill('SIGTERM');

try {
  await once(child, 'exit');
} catch {
  // The process may already have exited.
}

if (nonJsonLines.length > 0) {
  throw new Error(`MCP stdout contained non-JSON output: ${nonJsonLines[0]}`);
}

if (!sawSdkLogOnStderr) {
  throw new Error('Timed out before observing the SDK debug log on stderr.');
}
