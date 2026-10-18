#!/usr/bin/env node
'use strict';
// Deprecated alias: "leadwright" was renamed to "leonidas" (Leonidas of the Web) in 0.2.0.
if (process.argv[2] !== 'mcp') console.error('leadwright: deprecated command name, use "leonidas" instead.');
require('./leonidas').main(process.argv.slice(2)).catch(e => { console.error(`leonidas: ${e.message}`); process.exitCode = 1; });
