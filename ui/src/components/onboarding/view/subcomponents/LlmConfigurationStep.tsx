import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { authenticatedFetch } from '../../../../utils/api';

type LlmConfigurationStepProps = {
  onSaved: () => void | Promise<void>;
};

type PresetKey = 'anthropic' | 'openrouter' | 'minimax' | 'openai';

const PRESETS: Record<PresetKey, { type: string; baseUrl: string; model: string }> = {
  anthropic: { type: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5-20250929' },
  openrouter: { type: 'openai-chat', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5' },
  minimax: { type: 'openai-chat', baseUrl: 'https://api.minimaxi.com/v1', model: 'MiniMax-M2.7-highspeed' },
  openai: { type: 'openai-chat', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o' },
};

const PRESET_LABELS: Record<PresetKey, string> = {
  anthropic: 'Anthropic',
  openrouter: 'OpenRouter',
  minimax: 'MiniMax',
  openai: 'OpenAI',
};

const URL_TYPE_MAP: Array<{ re: RegExp; type: string }> = [
  { re: /anthropic\.com/i, type: 'anthropic' },
  { re: /openrouter\.ai/i, type: 'openai-chat' },
  { re: /openai\.com/i, type: 'openai-chat' },
  { re: /minimaxi?\.com/i, type: 'openai-chat' },
  { re: /deepseek/i, type: 'openai-chat' },
  { re: /together/i, type: 'openai-chat' },
];

function detectProviderType(url: string): string | null {
  for (const { re, type } of URL_TYPE_MAP) {
    if (re.test(url)) return type;
  }
  return null;
}

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

export default function LlmConfigurationStep({ onSaved }: LlmConfigurationStepProps) {
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [providerType, setProviderType] = useState('anthropic');
  const [autoDetected, setAutoDetected] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<PresetKey | null>(null);

  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [saving, setSaving] = useState(false);

  // Load existing config for prefill (unmasked)
  useEffect(() => {
    (async () => {
      try {
        const res = await authenticatedFetch('/api/config/provider');
        if (!res.ok) return;
        const data = await res.json();
        if (!data.exists || !data.provider) return;

        const p = data.provider;
        if (p.baseUrl) setBaseUrl(p.baseUrl);
        if (p.apiKey) setApiKey(p.apiKey);
        if (p.type) setProviderType(p.type);
        if (p.model) setModel(p.model);
      } catch { /* no existing config, fields stay empty */ }
    })();
  }, []);

  const handleBaseUrlChange = useCallback((value: string) => {
    setBaseUrl(value);
    setTestStatus('idle');
    setTestMessage('');
    const detected = detectProviderType(value);
    if (detected) {
      setProviderType(detected);
      setAutoDetected(true);
    } else {
      setAutoDetected(false);
    }
  }, []);

  const handlePresetClick = useCallback((key: PresetKey) => {
    const p = PRESETS[key];
    setSelectedPreset(key);
    setBaseUrl(p.baseUrl);
    setModel(p.model);
    setProviderType(p.type);
    setAutoDetected(false);
    setTestStatus('idle');
    setTestMessage('');
  }, []);

  const handleFieldChange = useCallback(() => {
    setTestStatus('idle');
    setTestMessage('');
  }, []);

  const canTest = baseUrl.trim() && apiKey.trim() && model.trim();

  const handleTest = useCallback(async () => {
    if (!canTest) return;
    setTestStatus('testing');
    setTestMessage('');
    try {
      const res = await authenticatedFetch('/api/config/test-connection', {
        method: 'POST',
        body: JSON.stringify({ providerType, baseUrl: baseUrl.trim(), apiKey: apiKey.trim(), model: model.trim() }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestStatus('success');
        setTestMessage(data.message || 'Connected successfully.');
      } else {
        setTestStatus('error');
        setTestMessage(data.error || 'Connection failed.');
      }
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Connection failed.');
    }
  }, [canTest, providerType, baseUrl, apiKey, model]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const { stringify: stringifyYaml, parse: parseYaml } = await import('yaml');

      // Read existing config to merge
      let existingConfig: Record<string, unknown> = {};
      try {
        const res = await authenticatedFetch('/api/config');
        if (res.ok) {
          const data = await res.json();
          if (data.raw) {
            existingConfig = parseYaml(data.raw) || {};
          }
        }
      } catch { /* start fresh */ }

      // Build merged config
      if (!existingConfig.models || typeof existingConfig.models !== 'object') {
        (existingConfig as Record<string, unknown>).models = {};
      }
      const models = existingConfig.models as Record<string, unknown>;
      if (!models.providers || typeof models.providers !== 'object') {
        models.providers = {};
      }
      const providers = models.providers as Record<string, unknown>;
      providers.edgeclaw = {
        type: providerType,
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
      };
      if (!models.entries || typeof models.entries !== 'object') {
        models.entries = {};
      }
      const entries = models.entries as Record<string, unknown>;
      entries.default = {
        provider: 'edgeclaw',
        name: model.trim(),
      };
      if (!existingConfig.version) existingConfig.version = 1;
      if (!existingConfig.agents) {
        (existingConfig as Record<string, unknown>).agents = { main: { model: 'default' } };
      }
      if (!existingConfig.memory) {
        (existingConfig as Record<string, unknown>).memory = { enabled: true };
      }

      const raw = stringifyYaml(existingConfig, { indent: 2, lineWidth: 0 });

      const saveRes = await authenticatedFetch('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ raw }),
      });

      if (!saveRes.ok) {
        const err = await saveRes.json();
        throw new Error(err.error || 'Failed to save configuration');
      }

      await onSaved();
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }, [providerType, baseUrl, apiKey, model, onSaved]);

  return (
    <div className="mx-auto w-full max-w-xl space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-foreground">LLM Provider Setup</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Configure your AI model provider to get started.
        </p>
      </div>

      <div className="border-t border-border" />

      {/* QUICK PRESETS */}
      <div>
        <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Quick Presets
        </div>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(PRESETS) as PresetKey[]).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => handlePresetClick(key)}
              className={`rounded-lg border px-4 py-2 text-sm transition-colors ${
                selectedPreset === key
                  ? 'border-foreground bg-muted text-foreground'
                  : 'border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground'
              }`}
            >
              {PRESET_LABELS[key]}
            </button>
          ))}
        </div>
      </div>

      {/* CONNECTION DETAILS */}
      <div>
        <div className="mb-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Connection Details
        </div>

        <div className="space-y-5">
          {/* API Base URL */}
          <div>
            <label htmlFor="llm-base-url" className="mb-1 block text-sm font-medium text-foreground">
              API Base URL
            </label>
            <p className="mb-2 text-xs text-muted-foreground">Your provider's API endpoint</p>
            <input
              id="llm-base-url"
              type="text"
              value={baseUrl}
              onChange={(e) => { handleBaseUrlChange(e.target.value); handleFieldChange(); }}
              placeholder="https://api.anthropic.com"
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {/* API Key */}
          <div>
            <label htmlFor="llm-api-key" className="mb-1 block text-sm font-medium text-foreground">
              API Key
            </label>
            <input
              id="llm-api-key"
              type="text"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); handleFieldChange(); }}
              placeholder="sk-..."
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {/* Model ID */}
          <div>
            <label htmlFor="llm-model" className="mb-1 block text-sm font-medium text-foreground">
              Model ID
            </label>
            <p className="mb-2 text-xs text-muted-foreground">The exact model identifier from your provider</p>
            <input
              id="llm-model"
              type="text"
              value={model}
              onChange={(e) => { setModel(e.target.value); handleFieldChange(); }}
              placeholder="claude-sonnet-4-5-20250929"
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {/* Protocol Type */}
          <div>
            <div className="mb-1 flex items-center gap-2">
              <label htmlFor="llm-protocol" className="text-sm font-medium text-foreground">
                Protocol Type
              </label>
              {autoDetected && (
                <span className="text-xs text-muted-foreground">Auto-detected from URL</span>
              )}
            </div>
            <select
              id="llm-protocol"
              value={providerType}
              onChange={(e) => { setProviderType(e.target.value); setAutoDetected(false); handleFieldChange(); }}
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
            >
              <option value="anthropic">anthropic (/v1/messages)</option>
              <option value="openai-chat">openai-chat (/chat/completions)</option>
              <option value="openai-responses">openai-responses (/responses)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 border-t border-border pt-6">
        <button
          type="button"
          onClick={handleTest}
          disabled={!canTest || testStatus === 'testing'}
          className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
        >
          {testStatus === 'testing' ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Testing...
            </span>
          ) : (
            'Test Connection'
          )}
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={testStatus !== 'success' || saving}
          className="rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
        >
          {saving ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Saving...
            </span>
          ) : (
            'Save'
          )}
        </button>
      </div>

      {/* Test result */}
      {testMessage && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${
          testStatus === 'success'
            ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-800/40 dark:bg-green-900/10 dark:text-green-300'
            : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800/40 dark:bg-red-900/10 dark:text-red-300'
        }`}>
          {testStatus === 'success' ? '✓ ' : '✗ '}{testMessage}
        </div>
      )}
    </div>
  );
}
