# Metrics Framework

Framework extensível para implementação de métricas de avaliação no sistema Omniforge.

## Visão Geral

Este módulo fornece classes base e utilitários para criar métricas personalizadas que avaliam outputs de sistemas sob teste contra resultados esperados.

## Componentes Principais

### BaseMetric

Classe abstrata que implementa a interface `Metric` e fornece funcionalidade comum:

- Validação de scores no intervalo [0, 1]
- Aplicação automática de threshold
- Error handling com soft-fail
- Medição de latência

**Exemplo de uso:**

```typescript
import { BaseMetric } from './base.js';

class ExactMatchMetric extends BaseMetric<string, string> {
  constructor() {
    super({
      name: 'exact-match',
      threshold: 1.0,
      strict: true,
      description: 'Verifica correspondência exata entre output e expected',
    });
  }

  protected async measureImpl(input: MetricInput<string, string>): Promise<Partial<MetricScore>> {
    const match = input.output === input.expected;
    return {
      score: this.booleanToScore(match),
      reason: match ? 'Output matches expected exactly' : 'Output does not match expected',
    };
  }
}
```

### CompositeMetric

Classe que compõe múltiplas métricas com pesos, calculando uma média ponderada:

- Suporta pesos diferentes para cada métrica
- Detecta falhas de métricas strict
- Agrega custos e latências
- Inclui scores constituintes no metadata

**Exemplo de uso:**

```typescript
import { CompositeMetric } from './base.js';

const composite = new CompositeMetric({
  name: 'quality-composite',
  threshold: 0.75,
  strict: true,
  description: 'Métrica composta de qualidade',
  metrics: [
    { metric: exactMatchMetric, weight: 2 },
    { metric: semanticSimilarityMetric, weight: 1 },
  ],
});
```

### LLMJudgeMetric

Wrapper que converte uma implementação de `Judge` em uma `Metric`:

- Usa qualquer Judge (LLM, deterministic, etc.)
- Converte JudgeOutput para MetricScore
- Suporta configuração de threshold e strict mode
- Preserva metadata do judge (cache hit, raw output, etc.)

**Exemplo de uso:**

```typescript
import { LLMJudgeMetric, createLLMJudgeMetric } from './llm-judge.js';
import { LLMJudge } from '../judges/llm-judge.js';

const judge = new LLMJudge({
  model: 'cc/claude-sonnet-4-6',
  temperature: 0,
  iterations: 1,
});

// Usando o construtor diretamente
const metric1 = new LLMJudgeMetric({
  name: 'llm-quality-judge',
  threshold: 0.8,
  strict: true,
  judge,
  rubric: 'Avalie a qualidade do output baseado nos critérios X, Y, Z',
  steps: ['Verificar precisão', 'Verificar completude'],
});

// Usando a factory function
const metric2 = createLLMJudgeMetric(
  'llm-quality-judge',
  judge,
  'Avalie a qualidade do output baseado nos critérios X, Y, Z',
  {
    threshold: 0.8,
    strict: true,
    steps: ['Verificar precisão', 'Verificar completude'],
  }
);
```

### Helper Functions

#### scoreToBoolean

Converte um score numérico para booleano baseado em um threshold:

```typescript
import { scoreToBoolean } from './base.js';

const passed = scoreToBoolean(0.8, 0.7); // true
const passed = scoreToBoolean(0.5, 0.7); // false
const passed = scoreToBoolean(0.6); // true (threshold default 0.5)
```

## Implementando Métricas Personalizadas

### Passo 1: Estender BaseMetric

```typescript
import { BaseMetric } from './base.js';
import type { MetricInput, MetricScore } from '../types.js';

class MyCustomMetric extends BaseMetric<MyOutputType, MyExpectedType> {
  constructor() {
    super({
      name: 'my-custom-metric',
      threshold: 0.7,
      strict: false,
      description: 'Descrição da minha métrica personalizada',
    });
  }

  protected async measureImpl(
    input: MetricInput<MyOutputType, MyExpectedType>
  ): Promise<Partial<MetricScore>> {
    // Implementar lógica de medição aqui
    const score = this.computeScore(input);
    const reason = this.generateReason(input, score);

    return {
      score,
      reason,
      // Opcional: cost_usd, latency_ms, meta
    };
  }

  private computeScore(input: MetricInput<MyOutputType, MyExpectedType>): number {
    // Calcular score no intervalo [0, 1]
    // Use this.clampScore() para garantir o intervalo
    return this.clampScore(/* seu cálculo */);
  }

  private generateReason(input: MetricInput<MyOutputType, MyExpectedType>, score: number): string {
    // Gerar razão legível para o score
    return `Score ${score} baseado em ...`;
  }
}
```

### Passo 2: Registrar a Métrica

```typescript
import { myCustomMetric } from './my-custom-metric.js';

// Registrar no sistema de avaliação
const metricRegistry = {
  'my-custom-metric': new MyCustomMetric(),
  // ... outras métricas
};
```

## Boas Práticas

1. **Sempre usar clampScore**: Garanta que scores estejam no intervalo [0, 1]
2. **Fornecer reasons claras**: A razão deve explicar por que o score foi atribuído
3. **Usar strict mode apropriadamente**: Métricas críticas devem ter `strict: true`
4. **Documentar a métrica**: Forneça descrições claras no construtor
5. **Tratar erros gracefully**: O BaseMetric já faz soft-fail, mas forneça reasons específicas

## Testando Métricas

```typescript
import { describe, it, expect } from 'vitest';
import { MyCustomMetric } from './my-custom-metric.js';

describe('MyCustomMetric', () => {
  it('should measure correctly', async () => {
    const metric = new MyCustomMetric();
    const input: MetricInput = {
      testCase: { /* ... */ },
      output: { /* ... */ },
      expected: { /* ... */ },
    };

    const result = await metric.measure(input);

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.reason).toBeDefined();
  });
});
```

## Roadmap

- [ ] Adicionar mais métricas pré-implementadas (semantic similarity, BLEU, ROUGE, etc.)
- [ ] Suporte a métricas assíncronas com streaming
- [ ] Cache de resultados de métricas
- [ ] Métricas com estado (para avaliações multi-step)
- [ ] Integração com sistema de calibração de judges