#!/usr/bin/env node

import { runCli } from './cli';

void runCli().then((exitCode) => {
  process.exitCode = exitCode;
});
