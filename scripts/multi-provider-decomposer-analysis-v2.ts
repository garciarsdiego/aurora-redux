#!/usr/bin/env tsx
/**
 * Multi-Provider Decomposer Failure Analysis (V2 - Direct API)
 *
 * Uses direct Omniroute API calls instead of the internal callOmnirouteWithUsage function.
 */

interface AnalysisResult {
  model: string;
  rootCause: string;
  suggestions: string[];
  confidence: number;
}

interface ConsensusResult {
  commonThemes: string[];
  unifiedRecommendation: string;
  promptVariants: Array<{
    id: string;
    addition: string;
    rationale: string;
  }>;
}

const MODELS = [
  'cc/claude-sonnet-4-6',
  'cc/claude-opus-4-6',
  'cc/claude-sonnet-4-6' // Using Claude models as they're available
];

const PROMPT = `You are analyzing failures in the Omniforge decomposer system.

CURRENT FAILURE:
- Metric: H7 Falsifiable Criteria
- Current Score: 0% (across all test cases)
- Expected: >= 70%
- Issue: Decomposer does NOT generate acceptance criteria with MUST/SHOULD language

CONTEXT:
- System Prompt Location: src/brain/decomposer.ts
- Metrics Implementation: src/v2/evals/metrics/decomposer.ts (H7_FalsifiableCriteriaMetric)
- Test Case: "Tetris Web app" objective generated 9 tasks with 0 MUST/SHOULD criteria

EXAMPLE OF PROBLEM:
Generated task: "Define tetromino shape and color data"
Expected: "Define tetromino shape data MUST include all 7 standard shapes (I, O, T, S, Z, J, L) with distinct colors"

TASK:
1. Identify the ROOT CAUSE of why the decomposer fails to generate MUST/SHOULD language
2. Provide 3 SPECIFIC suggestions to fix this in the system prompt
3. Rate your confidence in this analysis (0-1)

Output ONLY valid JSON:
{
  "rootCause": "string",
  "suggestions": ["string1", "string2", "string3"],
  "confidence": 0.0-1.0
}`;

async function callOmnirouteDirect(model: string, prompt: string): Promise<string> {
  const response = await fetch('http://localhost:20228/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: model,
      messages: [
        { role: 'system', content: 'You are a helpful AI assistant that responds only in valid JSON.' },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1000,
      temperature: 0.3
    })
  });

  if (!response.ok) {
    throw new Error(`Omniroute API error: ${response.status}`);
  }

  // Parse SSE response
  const text = await response.text();
  const lines = text.split('\n').filter(line => line.startsWith('data: '));

  let fullContent = '';
  for (const line of lines) {
    const data = line.replace('data: ', '').trim();
    if (data === '[DONE]') continue;

    try {
      const parsed = JSON.parse(data);
      if (parsed.choices?.[0]?.delta?.content) {
        fullContent += parsed.choices[0].delta.content;
      }
    } catch (e) {
      // Skip invalid JSON
    }
  }

  return fullContent;
}

async function analyzeWithModel(model: string): Promise<AnalysisResult> {
  console.log(`\n🔍 Analyzing with ${model}...`);

  try {
    const result = await callOmnirouteDirect(model, PROMPT);

    // Extract JSON from response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    console.log(`   ✅ Analysis complete (confidence: ${(parsed.confidence * 100).toFixed(0)}%)`);
    console.log(`   Root cause: ${parsed.rootCause.substring(0, 80)}...`);

    return {
      model,
      rootCause: parsed.rootCause,
      suggestions: parsed.suggestions,
      confidence: parsed.confidence
    };
  } catch (err) {
    console.error(`   ❌ Error with ${model}:`, err);
    return {
      model,
      rootCause: 'Analysis failed',
      suggestions: [],
      confidence: 0
    };
  }
}

async function generateConsensus(analyses: AnalysisResult[]): Promise<ConsensusResult> {
  console.log('\n🎯 Generating consensus using Claude Opus...');

  const consensusPrompt = `You are synthesizing analysis from multiple AI models to create a unified recommendation.

ANALYSES:
${analyses.map(a => `
Model: ${a.model}
Root Cause: ${a.rootCause}
Suggestions: ${a.suggestions.join(', ')}
Confidence: ${a.confidence}
`).join('\n')}

TASK:
1. Identify COMMON THEMES across all analyses
2. Create a UNIFIED RECOMMENDATION for fixing H7
3. Generate 3 SPECIFIC prompt variants to test

Output ONLY valid JSON:
{
  "commonThemes": ["string1", "string2"],
  "unifiedRecommendation": "string",
  "promptVariants": [
    {
      "id": "variant-1",
      "addition": "exact text to add to system prompt",
      "rationale": "why this approach"
    }
  ]
}`;

  try {
    const result = await callOmnirouteDirect('cc/claude-opus-4-6', consensusPrompt);

    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in consensus response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    console.log(`   ✅ Consensus generated`);
    console.log(`   Common themes: ${parsed.commonThemes.length}`);
    console.log(`   Variants: ${parsed.promptVariants.length}`);

    return parsed;
  } catch (err) {
    console.error(`   ❌ Consensus generation failed:`, err);
    return {
      commonThemes: [],
      unifiedRecommendation: 'Consensus failed',
      promptVariants: []
    };
  }
}

async function main() {
  console.log('🚀 Multi-Provider Decomposer Failure Analysis (REAL)');
  console.log('=====================================================\n');
  console.log('Target: H7 Falsifiable Criteria (currently 0%)');
  console.log(`Models: ${MODELS.join(', ')}`);
  console.log('Omniroute: http://localhost:20228 ✅');

  // Phase 1: Parallel analysis with multiple models
  console.log('\n📊 PHASE 1: Multi-Provider Analysis');
  console.log('─'.repeat(50));

  const analyses = await Promise.all(
    MODELS.map(model => analyzeWithModel(model))
  );

  // Phase 2: Consensus generation
  console.log('\n📊 PHASE 2: Consensus Generation');
  console.log('─'.repeat(50));

  const consensus = await generateConsensus(analyses);

  // Phase 3: Output results
  console.log('\n📊 PHASE 3: Results');
  console.log('─'.repeat(50));

  console.log('\n🎯 Common Themes:');
  consensus.commonThemes.forEach((theme, i) => {
    console.log(`   ${i + 1}. ${theme}`);
  });

  console.log('\n💡 Unified Recommendation:');
  console.log(`   ${consensus.unifiedRecommendation}`);

  console.log('\n🧬 Prompt Variants:');
  consensus.promptVariants.forEach((variant, i) => {
    console.log(`\n   Variant ${i + 1}: ${variant.id}`);
    console.log(`   Rationale: ${variant.rationale}`);
    console.log(`   Addition: "${variant.addition.substring(0, 100)}..."`);
  });

  // Phase 4: Save to file
  const fs = await import('node:fs');
  const output = {
    timestamp: new Date().toISOString(),
    analyses,
    consensus
  };

  fs.writeFileSync(
    'data/decomposer-multi-provider-analysis-real.json',
    JSON.stringify(output, null, 2)
  );

  console.log('\n✅ Analysis saved to data/decomposer-multi-provider-analysis-real.json');

  // Phase 5: Next steps
  console.log('\n🚀 Next Steps:');
  console.log('   1. Review prompt variants in data/decomposer-multi-provider-analysis-real.json');
  console.log('   2. Test variants using: npx tsx scripts/test-decomposer-variant.ts <variant-id>');
  console.log('   3. Run eval: npx tsx scripts/run-tetris-eval.ts');
  console.log('   4. Compare H7 scores before/after variant');
  console.log('   5. Deploy best variant to production');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});