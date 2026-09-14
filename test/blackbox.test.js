'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

assert.ok(fs.existsSync(path.join(root, 'dist', 'app.min.js')), 'Build output is missing. Run npm run build first.');
assert.ok(fs.existsSync(path.join(root, 'dist', 'styles.min.css')), 'CSS build output is missing. Run npm run build first.');
assert.ok(fs.existsSync(path.join(root, 'samples', 'sample-retail-sales.csv')));
assert.ok(fs.existsSync(path.join(root, 'api', 'ai-insights.js')));
assert.ok(fs.existsSync(path.join(root, 'api', 'health.js')));

const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
assert.match(envExample, /^ANTHROPIC_API_KEY=$/m);
assert.doesNotMatch(envExample, /sk-ant-[A-Za-z0-9_-]+/);

console.log('blackbox smoke checks passed');
