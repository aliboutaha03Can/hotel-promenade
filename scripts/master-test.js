const { spawn } = require('child_process');
const dotenv = require('dotenv');

dotenv.config();

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: false,
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnv }
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
    });
  });
}

async function main() {
  console.log('[Master Test] Step 1/3 - node test suite');
  if (process.platform === 'win32') {
    await run('cmd.exe', ['/d', '/s', '/c', npmCmd, 'test']);
  } else {
    await run(npmCmd, ['test']);
  }

  console.log('[Master Test] Step 2/3 - browser role/sidebar validation');
  await run(process.execPath, ['scripts/ui-master-test.js']);

  const stressEnv = {};
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT_ID) {
    stressEnv.LIVE_TELEGRAM_STRESS = 'true';
  }
  if (!process.env.STRESS_TEST_EMAIL_RECIPIENT && process.env.GMAIL_USER) {
    stressEnv.STRESS_TEST_EMAIL_RECIPIENT = process.env.GMAIL_USER;
  }

  console.log('[Master Test] Step 3/3 - end-to-end stress validation');
  await run(process.execPath, ['scripts/stress-test.js'], stressEnv);

  console.log('[Master Test] All stages passed.');
}

main().catch((error) => {
  console.error('[Master Test] FAILED:', error);
  process.exitCode = 1;
});
