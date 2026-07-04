import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { scanDirectory, scanTextForSecrets } from '../../src/v2/security/secret-scan.js';

describe('secret scan guard', () => {
  it('detects committed LLM, Telegram and Slack secrets', () => {
    const llmKey = ['sk', '68e31a43c24d23f3', 'b33326eca9a4c7'].join('-');
    const telegramToken = ['1234567890', 'AAFakeTokenValueWithEnoughChars_abcdefghi'].join(':');
    const slackWebhook = [
      'https://hooks.slack.com/services',
      'T00000000',
      'B00000000',
      'XXXXXXXXXXXXXXXXXXXXXXXX',
    ].join('/');

    const findings = scanTextForSecrets(
      [
        `OMNIROUTE_API_KEY=${llmKey}`,
        `TELEGRAM_BOT_TOKEN=${telegramToken}`,
        `webhookUrl: '${slackWebhook}'`,
      ].join('\n'),
      'fixture.txt',
    );

    expect(findings.map((finding) => finding.ruleId)).toEqual([
      'omniroute-api-key',
      'telegram-bot-token',
      'slack-webhook-url',
    ]);
    expect(findings.every((finding) => !finding.redacted.includes('FakeTokenValue'))).toBe(true);
  });

  it('does not flag placeholders or local .env files during repository scans', () => {
    const root = mkdtempSync(join(tmpdir(), 'omniforge-secret-scan-'));
    const localOnlyKey = ['sk', 'local', 'only', 'not', 'scanned', 'abcdef'].join('-');
    try {
      writeFileSync(join(root, '.env'), `OMNIROUTE_API_KEY=${localOnlyKey}\n`);
      writeFileSync(join(root, '.env.example'), 'OMNIROUTE_API_KEY=\nTELEGRAM_BOT_TOKEN=\n');
      mkdirSync(join(root, 'docs'));
      writeFileSync(
        join(root, 'docs', 'example.md'),
        'Use OMNIROUTE_API_KEY=CHANGE_ME or OMNIROUTE_API_KEY=[REDACTED_OMNIROUTE_API_KEY].\n',
      );

      expect(scanDirectory(root)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
