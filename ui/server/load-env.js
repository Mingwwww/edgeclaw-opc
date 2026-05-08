import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  applyConfigToProcessEnv,
  getEdgeClawConfigPath,
  readEdgeClawConfigFile,
} from './services/edgeclawConfig.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REPO_ROOT = path.resolve(__dirname, '../..');
const REQUIRED_EDGECLAW_ENV_KEYS = [
  'EDGECLAW_API_BASE_URL',
  'EDGECLAW_API_KEY',
  'EDGECLAW_MODEL',
];

function normalizeEnvValue(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function applyDerivedRuntimeEnv() {
  const { config } = readEdgeClawConfigFile();
  applyConfigToProcessEnv(config);
}

export function getRepoRootDir() {
  return REPO_ROOT;
}

export function getEdgeClawConfigFilePath() {
  return getEdgeClawConfigPath();
}

export function hasEdgeClawConfigFile() {
  return fs.existsSync(getEdgeClawConfigPath());
}

export function getMissingEdgeClawEnvKeys() {
  return REQUIRED_EDGECLAW_ENV_KEYS.filter(
    key => !normalizeEnvValue(process.env[key]),
  );
}

export function assertRequiredEdgeClawEnv() {
  const missingKeys = getMissingEdgeClawEnvKeys();
  if (missingKeys.length > 0) {
    console.warn(
      `[WARN] Missing EdgeClaw config: ${missingKeys.join(', ')}. ` +
        `The setup wizard will be shown during onboarding.`,
    );
  }
  return missingKeys;
}

export function loadRootEdgeClawEnv() {
  applyDerivedRuntimeEnv();

  if (!process.env.DATABASE_PATH) {
    process.env.DATABASE_PATH = path.join(os.homedir(), '.cloudcli', 'auth.db');
  }

  return hasEdgeClawConfigFile();
}

loadRootEdgeClawEnv();
