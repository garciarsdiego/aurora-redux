// Micro-smoke: exercise each transport THROUGH the real built chokepoint.
// Usage: node scripts/_smoke_transport.mjs glm/glm-5.2 kimi/kimi-for-coding ...
import 'dotenv/config';
import { callOmnirouteWithUsage } from '../dist/utils/omniroute-call.js';

const models = process.argv.slice(2);
for (const model of models) {
  const t = Date.now();
  try {
    const r = await callOmnirouteWithUsage({
      systemPrompt: 'You are terse. Output only what is asked.',
      userPrompt: 'Reply with ONLY this exact JSON and nothing else: {"ok": true, "n": 7}',
      model,
      temperature: 0,
    });
    const dt = ((Date.now() - t) / 1000).toFixed(1);
    console.log(`[${model}] OK ${dt}s | used=${r.model_used} | content=${JSON.stringify(r.content).slice(0, 90)} | usage=${JSON.stringify(r.usage)}`);
  } catch (e) {
    console.log(`[${model}] ERR ${((Date.now() - t) / 1000).toFixed(1)}s | ${String(e.message).slice(0, 180)}`);
  }
}
