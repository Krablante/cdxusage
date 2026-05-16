#!/usr/bin/env node
import { main } from '../src/cli.mjs';

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(`${error?.message ?? error}\n`);
  process.exitCode = 1;
}
