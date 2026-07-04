import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendSlackGateNotification } from '../../src/hitl/slack.js';

describe('sendSlackGateNotification', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts to webhook URL with correct Content-Type', async () => {
    await sendSlackGateNotification({
      webhookUrl: 'https://hooks.slack.com/test',
      taskName: 'Build Docker Image',
      workspace: 'internal',
      kind: 'llm_call',
      model: 'cc/claude-opus-4-7',
      objective: 'Deploy to production',
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.slack.com/test');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.method).toBe('POST');
  });

  it('payload contains task name, kind, model, workspace and objective', async () => {
    await sendSlackGateNotification({
      webhookUrl: 'https://hooks.slack.com/test',
      taskName: 'Deploy API',
      workspace: 'client-a',
      kind: 'cli_spawn',
      model: null,
      objective: 'Release v2',
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { blocks: unknown[] };

    const bodyStr = JSON.stringify(body);
    expect(bodyStr).toContain('Deploy API');
    expect(bodyStr).toContain('cli_spawn');
    expect(bodyStr).toContain('(default)');
    expect(bodyStr).toContain('client-a');
    expect(bodyStr).toContain('Release v2');
  });

  it('payload has Block Kit structure with header, sections and context', async () => {
    await sendSlackGateNotification({
      webhookUrl: 'https://hooks.slack.com/test',
      taskName: 'T',
      workspace: 'w',
      kind: 'llm_call',
      model: null,
      objective: 'O',
    });

    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { blocks: { type: string }[] };

    const types = body.blocks.map((b) => b.type);
    expect(types).toContain('header');
    expect(types).toContain('section');
    expect(types).toContain('context');
  });

  it('non-ok response is non-fatal — does not throw', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 400 });
    await expect(
      sendSlackGateNotification({
        webhookUrl: 'https://hooks.slack.com/test',
        taskName: 'T',
        workspace: 'w',
        kind: 'llm_call',
        model: null,
        objective: '',
      }),
    ).resolves.toBeUndefined();
  });

  it('network error is non-fatal — does not throw', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(
      sendSlackGateNotification({
        webhookUrl: 'https://hooks.slack.com/test',
        taskName: 'T',
        workspace: 'w',
        kind: 'llm_call',
        model: null,
        objective: '',
      }),
    ).resolves.toBeUndefined();
  });

  it('timeout abort is non-fatal — does not throw', async () => {
    mockFetch.mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
    );
    await expect(
      sendSlackGateNotification({
        webhookUrl: 'https://hooks.slack.com/test',
        taskName: 'T',
        workspace: 'w',
        kind: 'llm_call',
        model: null,
        objective: '',
      }),
    ).resolves.toBeUndefined();
  });
});
