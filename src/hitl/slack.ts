export interface SlackGateOpts {
  webhookUrl: string;
  taskName: string;
  workspace: string;
  kind: string;
  model: string | null;
  objective: string;
  gateId: string;
  listenerUrl?: string; // public URL (ex: ngrok) — habilita botões clicáveis
}

export async function sendSlackGateNotification(opts: SlackGateOpts): Promise<void> {
  const { webhookUrl, taskName, workspace, kind, model, objective, gateId, listenerUrl } = opts;

  const blocks: unknown[] = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: '\u23F8  HITL Gate \u2014 Aprova\u00e7\u00e3o Necess\u00e1ria',
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Task:*\n${taskName}` },
        { type: 'mrkdwn', text: `*Kind:*\n${kind}` },
        { type: 'mrkdwn', text: `*Model:*\n${model ?? '(default)'}` },
        { type: 'mrkdwn', text: `*Workspace:*\n${workspace}` },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Objective:*\n${objective || '(sem objetivo)'}`,
      },
    },
  ];

  if (listenerUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '\u2713 Aprovar', emoji: true },
          style: 'primary',
          url: `${listenerUrl}?gate_id=${gateId}&decision=approved`,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '\u2717 Rejeitar', emoji: true },
          style: 'danger',
          url: `${listenerUrl}?gate_id=${gateId}&decision=rejected`,
        },
      ],
    });
  } else {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Responda com \`y\` no terminal para aprovar. Gate: \`${gateId}\``,
        },
      ],
    });
  }

  const payload = { blocks };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 5_000);

  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    if (!res.ok) {
      console.warn(`[HITL] Slack webhook retornou ${res.status} \u2014 continuando com prompt terminal`);
    }
  } catch (err) {
    console.warn(`[HITL] Slack webhook falhou: ${(err as Error).message} \u2014 continuando com prompt terminal`);
  } finally {
    clearTimeout(timer);
  }
}
