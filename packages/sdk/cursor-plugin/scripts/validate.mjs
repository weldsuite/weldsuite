#!/usr/bin/env node
/**
 * Lightweight structural checks for the WeldSuite Cursor plugin.
 * Run from repo root: node packages/sdk/cursor-plugin/scripts/validate.mjs
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(pluginRoot, '../../..');
const errors = [];

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function parseFrontmatter(content) {
  if (!content.startsWith('---\n')) return null;
  const end = content.indexOf('\n---\n', 4);
  if (end === -1) return null;
  const fields = {};
  for (const line of content.slice(4, end).split('\n')) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    fields[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fields;
}

const REQUIRED_FILES = [
  'agents/weldflow-dispatcher.md',
  'agents/weldflow-task-fixer.md',
  'rules/weldsuite-mcp.mdc',
  'skills/fix-task/SKILL.md',
  'skills/list-tasks/SKILL.md',
  'skills/claim-task/SKILL.md',
  'skills/done-task/SKILL.md',
  'skills/enrich-task/SKILL.md',
  'README.md',
];

async function checkPluginManifest() {
  const manifestPath = path.join(pluginRoot, '.cursor-plugin/plugin.json');
  if (!(await exists(manifestPath))) {
    errors.push(`Missing ${manifestPath}`);
    return;
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (!manifest.name || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(manifest.name)) {
    errors.push(`Invalid plugin name: ${manifest.name}`);
  }
  if (!manifest.logo || !(await exists(path.join(pluginRoot, manifest.logo)))) {
    errors.push(`Logo missing: ${manifest.logo}`);
  }
}

async function checkMcpConfig() {
  const mcpPath = path.join(pluginRoot, 'mcp.json');
  if (!(await exists(mcpPath))) {
    errors.push('Missing mcp.json');
    return;
  }
  const mcp = JSON.parse(await fs.readFile(mcpPath, 'utf8'));
  const entry = mcp.weldsuite ?? mcp.mcpServers?.weldsuite;
  if (!entry?.url) errors.push('mcp.json must define weldsuite.url');
}

async function checkMarketplace() {
  const marketplacePath = path.join(repoRoot, '.cursor-plugin/marketplace.json');
  if (!(await exists(marketplacePath))) {
    errors.push('Missing repo-root .cursor-plugin/marketplace.json');
    return;
  }
  const market = JSON.parse(await fs.readFile(marketplacePath, 'utf8'));
  const plug = market.plugins?.find((p) => p.name === 'weldsuite');
  if (!plug) {
    errors.push('marketplace.json missing weldsuite plugin entry');
  } else if (plug.source !== 'cursor-plugin') {
    errors.push(`Expected source "cursor-plugin", got ${plug.source}`);
  }
}

function checkFrontmatterFields(rel, fm) {
  if (!fm) {
    errors.push(`${rel}: missing frontmatter`);
  } else if (!fm.name && !rel.endsWith('.mdc')) {
    errors.push(`${rel}: missing name`);
  } else if (!fm.description) {
    errors.push(`${rel}: missing description`);
  }
}

async function checkRequiredFile(rel) {
  const full = path.join(pluginRoot, rel);
  if (!(await exists(full))) {
    errors.push(`Missing ${rel}`);
    return;
  }
  const isMarkdown = rel.endsWith('.md') || rel.endsWith('.mdc');
  if (!isMarkdown || rel === 'README.md') return;
  checkFrontmatterFields(rel, parseFrontmatter(await fs.readFile(full, 'utf8')));
}

async function main() {
  await checkPluginManifest();
  await checkMcpConfig();
  await checkMarketplace();
  for (const rel of REQUIRED_FILES) {
    await checkRequiredFile(rel);
  }

  if (errors.length) {
    console.error('Plugin validation failed:\n' + errors.map((e) => `  - ${e}`).join('\n'));
    process.exit(1);
  }
  console.log('WeldSuite Cursor plugin OK:', path.relative(repoRoot, pluginRoot));
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
