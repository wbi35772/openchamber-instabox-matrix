#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { createKeepalive } = require(path.join(__dirname, '..', 'lib', 'keepalive.js'));

function log(line) {
  process.stdout.write(new Date().toISOString() + ' ' + line + '\n');
}

(async () => {
  const keepalive = createKeepalive({ log });
  const patches = await keepalive.tick();
  for (const { entry, patch } of patches) {
    log(
      'tick ' + entry.account + '/' + entry.machineId +
      ' action=' + (patch.lastWakeAction || '-') +
      ' ok=' + patch.lastOk +
      ' retryAt=' + (patch.retryAt || '-') +
      (patch.lastError ? ' error=' + patch.lastError : ''),
    );
  }
  process.exit(0);
})().catch((error) => {
  log('tick crashed: ' + ((error && error.stack) || error));
  process.exit(1);
});
