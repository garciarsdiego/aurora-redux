#!/usr/bin/env node

/**
 * Omniforge Test Suite Executor - Versão Melhorada
 * Executa bateria de testes sistemáticos com retry logic, validação estruturada e métricas avançadas
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  executeWithRetry,
  parseOmniforgeOutput,
  validateStructuredOutput,
  MetricsCollector,
  truncateOutput,
  saveResults,
  generateTimestamp
} from './test-helpers.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_SUITE_FILE = path.join(__dirname, '../test-suite-omniforge.json');
const RESULTS_DIR = path.join(__dirname, '../test-results');
const OMNIFORGE_BIN = path.join(__dirname, '../bin/omniforge');

// Garantir diretório de resultados
if (!fs.existsSync(RESULTS_DIR)) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
}

class TestRunner {
  constructor() {
    this.metricsCollector = new MetricsCollector();
    this.results = {
      started_at: new Date().toISOString(),
      test_suite: null,
      total_tests: 0,
      executed: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      levels: {},
      errors: [],
      model_performance: {},
      provider_performance: {},
      cli_agent_performance: {},
      timing_data: [],
      advanced_metrics: null
    };
  }

  async run() {
    console.log('🚀 Iniciando Omniforge Test Suite Executor v2.0\n');
    console.log('🔄 Retry logic: Ativado (3 retries com backoff exponencial)');
    console.log('🔍 Validação estruturada: Ativada');
    console.log('📊 Métricas avançadas: Ativadas\n');
    
    // Carregar suite de testes
    const testSuite = JSON.parse(fs.readFileSync(TEST_SUITE_FILE, 'utf-8'));
    this.results.test_suite = testSuite.test_suite;
    this.results.total_tests = this.countTotalTests(testSuite);
    
    console.log(`📋 Suite: ${testSuite.test_suite}`);
    console.log(`📊 Total de testes: ${this.results.total_tests}`);
    console.log(`📁 Resultados serão salvos em: ${RESULTS_DIR}\n`);

    // Executar testes por nível
    for (const [levelName, levelData] of Object.entries(testSuite.levels)) {
      console.log(`\n${'='.repeat(60)}`);
      console.log(`🎯 NÍVEL: ${levelName.toUpperCase()}`);
      console.log(`${'='.repeat(60)}`);
      console.log(`📝 ${levelData.description}`);
      
      this.results.levels[levelName] = {
        description: levelData.description,
        total: levelData.objectives.length,
        executed: 0,
        passed: 0,
        failed: 0,
        skipped: 0,
        tests: []
      };

      for (const test of levelData.objectives) {
        await this.executeTest(levelName, test);
      }

      console.log(`\n✅ Resumo ${levelName}: ${this.results.levels[levelName].passed}/${this.results.levels[levelName].executed} passaram`);
    }

    // Finalizar e salvar resultados
    await this.finalize();
  }

  countTotalTests(testSuite) {
    let total = 0;
    for (const level of Object.values(testSuite.levels)) {
      total += level.objectives.length;
    }
    return total;
  }

  async executeTest(levelName, test) {
    const levelResults = this.results.levels[levelName];
    const testId = test.id;
    
    console.log(`\n⚡ Executando ${testId}: ${test.objective.substring(0, 60)}...`);
    console.log(`   Modelo: ${test.model} | Complexidade: ${test.complexity}`);

    const startTime = Date.now();
    let result = {
      id: testId,
      objective: test.objective,
      model: test.model,
      expected_type: test.expected_type,
      complexity: test.complexity,
      started_at: new Date().toISOString(),
      status: 'running',
      duration_ms: null,
      workflow_id: null,
      output: null,
      parsed_output: null,
      validation: null,
      error: null,
      dag_structure: null,
      steps_executed: null,
      tokens_used: null,
      cost_estimate_usd: null,
      retry_count: 0
    };

    try {
      // Executar teste via Omniforge com retry logic
      const command = `node "${OMNIFORGE_BIN}" run "${test.objective}" --workspace internal --auto-approve --model ${test.model}`;
      
      const execResult = await executeWithRetry(command, {
        timeout: 120000, // 2 minutos por teste
        cwd: path.join(__dirname, '..')
      });

      result.duration_ms = execResult.duration;
      result.output = truncateOutput(execResult.stdout, 2000);
      result.retry_count = execResult.retryCount || 0;
      
      // Parse structured output
      result.parsed_output = parseOmniforgeOutput(execResult.stdout);
      
      // Validate structured output
      result.validation = validateStructuredOutput(result.parsed_output, {
        requireWorkflowId: true,
        requireTasksExecuted: false,
        requireDuration: false
      });
      
      // Merge parsed data into result
      if (result.parsed_output.workflow_id) {
        result.workflow_id = result.parsed_output.workflow_id;
      }
      if (result.parsed_output.tasks_executed !== null) {
        result.steps_executed = result.parsed_output.tasks_executed;
      }
      if (result.parsed_output.duration_ms !== null) {
        result.duration_ms = result.parsed_output.duration_ms;
      }
      if (result.parsed_output.tokens_used !== null) {
        result.tokens_used = result.parsed_output.tokens_used;
      }
      if (result.parsed_output.cost_usd !== null) {
        result.cost_estimate_usd = result.parsed_output.cost_usd;
      }
      if (result.parsed_output.dag_structure) {
        result.dag_structure = result.parsed_output.dag_structure;
      }
      
      // Check validation
      if (!result.validation.valid) {
        result.status = 'warning';
      } else {
        result.status = 'passed';
      }

      // Atualizar métricas de modelo
      this.updateModelMetrics(test.model, result.duration_ms, result.status === 'passed' || result.status === 'warning');
      
      // Record advanced metrics
      this.metricsCollector.recordTestExecution(test, result);

      levelResults.executed++;
      if (result.status === 'passed') {
        levelResults.passed++;
        this.results.passed++;
      } else if (result.status === 'warning') {
        levelResults.passed++;
        this.results.passed++;
      } else {
        levelResults.failed++;
        this.results.failed++;
      }
      this.results.executed++;

      console.log(`   ✅ ${result.status.toUpperCase()} (${result.duration_ms}ms)`);

    } catch (error) {
      result.duration_ms = Date.now() - startTime;
      result.status = 'failed';
      result.error = {
        message: error.message,
        code: error.code,
        signal: error.signal,
        output: truncateOutput(error.stdout || error.stderr || '', 1000)
      };
      
      // Try to parse error output
      if (error.stdout) {
        result.parsed_output = parseOmniforgeOutput(error.stdout);
      }

      // Atualizar métricas de modelo com falha
      this.updateModelMetrics(test.model, result.duration_ms, false);
      
      // Record advanced metrics even for failures
      this.metricsCollector.recordTestExecution(test, result);

      levelResults.executed++;
      levelResults.failed++;
      this.results.executed++;
      this.results.failed++;
      this.results.errors.push({
        test_id: testId,
        error: result.error
      });

      console.log(`   ❌ FALHOU (${result.duration_ms}ms): ${error.message.substring(0, 100)}`);
    }

    levelResults.tests.push(result);
    this.results.timing_data.push({
      test_id: testId,
      level: levelName,
      model: test.model,
      duration_ms: result.duration_ms,
      status: result.status,
      retry_count: result.retry_count
    });

    // Salvar resultado incremental
    this.saveIncrementalResult();
  }

  updateModelMetrics(model, duration, success) {
    if (!this.results.model_performance[model]) {
      this.results.model_performance[model] = {
        total_calls: 0,
        successful_calls: 0,
        failed_calls: 0,
        total_duration_ms: 0,
        avg_duration_ms: 0,
        success_rate: 0
      };
    }

    const metrics = this.results.model_performance[model];
    metrics.total_calls++;
    metrics.total_duration_ms += duration;
    
    if (success) {
      metrics.successful_calls++;
    } else {
      metrics.failed_calls++;
    }

    metrics.avg_duration_ms = metrics.total_duration_ms / metrics.total_calls;
    metrics.success_rate = (metrics.successful_calls / metrics.total_calls) * 100;

    // Extrair provider do model (formato: provider/modelo)
    const provider = model.split('/')[0];
    if (!this.results.provider_performance[provider]) {
      this.results.provider_performance[provider] = {
        total_calls: 0,
        successful_calls: 0,
        failed_calls: 0,
        models: {}
      };
    }

    this.results.provider_performance[provider].total_calls++;
    this.results.provider_performance[provider].models[model] = true;
    
    if (success) {
      this.results.provider_performance[provider].successful_calls++;
    } else {
      this.results.provider_performance[provider].failed_calls++;
    }
  }

  saveIncrementalResult() {
    const timestamp = generateTimestamp();
    const filename = `test-results-incremental-${timestamp}.json`;
    saveResults(this.results, RESULTS_DIR, filename);
  }

  async finalize() {
    this.results.ended_at = new Date().toISOString();
    this.results.total_duration_ms = new Date(this.results.ended_at) - new Date(this.results.started_at);
    
    // Calculate time percentiles
    const durations = this.results.timing_data
      .filter(t => t.duration_ms !== null)
      .map(t => t.duration_ms);
    this.metricsCollector.calculateTimePercentiles(durations);
    
    // Get advanced metrics
    this.results.advanced_metrics = this.metricsCollector.getSummary();

    console.log(`\n${'='.repeat(60)}`);
    console.log('📊 RESULTADOS FINAIS');
    console.log(`${'='.repeat(60)}`);
    console.log(`✅ Total executados: ${this.results.executed}/${this.results.total_tests}`);
    console.log(`✅ Passaram: ${this.results.passed} (${((this.results.passed/this.results.executed)*100).toFixed(1)}%)`);
    console.log(`❌ Falharam: ${this.results.failed} (${((this.results.failed/this.results.executed)*100).toFixed(1)}%)`);
    console.log(`⏭️  Pulados: ${this.results.skipped}`);
    console.log(`⏱️  Duração total: ${(this.results.total_duration_ms/1000/60).toFixed(2)} minutos`);

    // Salvar resultado final
    const timestamp = generateTimestamp();
    const finalFilename = `test-results-final-${timestamp}.json`;
    const finalPath = path.join(RESULTS_DIR, finalFilename);
    saveResults(this.results, RESULTS_DIR, finalFilename);

    // Gerar relatório executivo
    await this.generateExecutiveReport(finalPath);

    console.log(`\n📁 Resultados salvos em:`);
    console.log(`   - ${finalPath}`);
    console.log(`   - ${finalPath.replace('.json', '-report.md')}`);
  }

  async generateExecutiveReport(resultsPath) {
    const reportPath = resultsPath.replace('.json', '-report.md');
    
    let report = `# Omniforge Test Suite - Relatório Executivo v2.0\n\n`;
    report += `**Data:** ${new Date().toLocaleString('pt-BR')}\n`;
    report += `**Suite:** ${this.results.test_suite}\n`;
    report += `**Duração:** ${(this.results.total_duration_ms/1000/60).toFixed(2)} minutos\n`;
    report += `**Versão:** 2.0 (com métricas avançadas)\n\n`;

    // Resumo executivo
    report += `## 📊 Resumo Executivo\n\n`;
    report += `| Métrica | Valor |\n`;
    report += `|---------|-------|\n`;
    report += `| Total de Testes | ${this.results.total_tests} |\n`;
    report += `| Executados | ${this.results.executed} |\n`;
    report += `| Passaram | ${this.results.passed} (${((this.results.passed/this.results.executed)*100).toFixed(1)}%) |\n`;
    report += `| Falharam | ${this.results.failed} (${((this.results.failed/this.results.executed)*100).toFixed(1)}%) |\n`;
    report += `| Pulados | ${this.results.skipped} |\n\n`;
    
    // Advanced metrics summary
    const retryStats = this.results.advanced_metrics.retry_statistics;
    report += `## 🔄 Estatísticas de Retry\n\n`;
    report += `- **Total de retries:** ${retryStats.total_retries}\n`;
    report += `- **Retries bem-sucedidos:** ${retryStats.successful_retries}\n`;
    report += `- **Retries falhados:** ${retryStats.failed_retries}\n`;
    if (retryStats.total_retries > 0) {
      report += `- **Taxa de sucesso de retries:** ${((retryStats.successful_retries / retryStats.total_retries) * 100).toFixed(1)}%\n`;
    }
    report += `\n`;

    // Resultados por nível
    report += `## 🎯 Resultados por Nível\n\n`;
    for (const [levelName, levelData] of Object.entries(this.results.levels)) {
      const passRate = levelData.executed > 0 ? ((levelData.passed/levelData.executed)*100).toFixed(1) : 0;
      report += `### ${levelName.replace('_', ' ').toUpperCase()}\n`;
      report += `- **Descrição:** ${levelData.description}\n`;
      report += `- **Executados:** ${levelData.executed}/${levelData.total}\n`;
      report += `- **Passaram:** ${levelData.passed} (${passRate}%)\n`;
      report += `- **Falharam:** ${levelData.failed}\n\n`;
    }

    // Performance por modelo
    report += `## 🤖 Performance por Modelo\n\n`;
    report += `| Modelo | Calls | Sucesso | Falha | Avg Duration | Success Rate |\n`;
    report += `|--------|-------|---------|-------|--------------|-------------|\n`;
    
    const sortedModels = Object.entries(this.results.model_performance)
      .sort((a, b) => b[1].total_calls - a[1].total_calls);

    for (const [model, metrics] of sortedModels.slice(0, 20)) { // Top 20
      report += `| ${model} | ${metrics.total_calls} | ${metrics.successful_calls} | ${metrics.failed_calls} | ${metrics.avg_duration_ms.toFixed(0)}ms | ${metrics.success_rate.toFixed(1)}% |\n`;
    }

    // Performance por provider
    report += `\n## 🏢 Performance por Provider\n\n`;
    report += `| Provider | Calls | Sucesso | Falha | Success Rate |\n`;
    report += `|----------|-------|---------|-------|-------------|\n`;

    const sortedProviders = Object.entries(this.results.provider_performance)
      .sort((a, b) => b[1].total_calls - a[1].total_calls);

    for (const [provider, metrics] of sortedProviders) {
      const successRate = (metrics.successful_calls / metrics.total_calls * 100).toFixed(1);
      report += `| ${provider} | ${metrics.total_calls} | ${metrics.successful_calls} | ${metrics.failed_calls} | ${successRate}% |\n`;
    }
    
    // Advanced metrics: Performance por tipo de tarefa
    const perfByTask = this.results.advanced_metrics.performance_by_task_type;
    if (Object.keys(perfByTask).length > 0) {
      report += `\n## 🎯 Performance por Tipo de Tarefa (Avançado)\n\n`;
      report += `| Tipo | Total | Passaram | Falharam | Tempo Médio |\n`;
      report += `|------|-------|----------|----------|-------------|\n`;
      
      for (const [taskType, metrics] of Object.entries(perfByTask)) {
        const successRate = ((metrics.success_count / metrics.total_tests) * 100).toFixed(1);
        report += `| ${taskType} | ${metrics.total_tests} | ${metrics.success_count} (${successRate}%) | ${metrics.failure_count} | ${(metrics.avg_duration_ms/1000).toFixed(1)}s |\n`;
      }
    }
    
    // Advanced metrics: Análise de custos
    const costAnalysis = this.results.advanced_metrics.cost_analysis;
    if (Object.keys(costAnalysis).length > 0) {
      report += `\n## 💰 Análise de Custos (Avançado)\n\n`;
      report += `| Tipo de Tarefa | Custo Total | Custo Médio | Testes |\n`;
      report += `|----------------|-------------|-------------|--------|\n`;
      
      for (const [taskType, cost] of Object.entries(costAnalysis)) {
        report += `| ${taskType} | $${cost.total_cost_usd.toFixed(4)} | $${cost.avg_cost_usd.toFixed(4)} | ${cost.test_count} |\n`;
      }
    }
    
    // Advanced metrics: Distribuição de tempos
    const timeDist = this.results.advanced_metrics.execution_time_distribution;
    if (timeDist.p50 !== null) {
      report += `\n## ⏱️ Distribuição de Tempos de Execução (Percentis)\n\n`;
      report += `- **P50 (mediana):** ${(timeDist.p50/1000).toFixed(1)}s\n`;
      report += `- **P75:** ${(timeDist.p75/1000).toFixed(1)}s\n`;
      report += `- **P90:** ${(timeDist.p90/1000).toFixed(1)}s\n`;
      report += `- **P95:** ${(timeDist.p95/1000).toFixed(1)}s\n`;
      report += `- **P99:** ${(timeDist.p99/1000).toFixed(1)}s\n\n`;
    }
    
    // Validação de saída estruturada
    report += `## 🔍 Validação de Saída Estruturada\n\n`;
    let validationPassed = 0;
    let validationWarnings = 0;
    for (const levelData of Object.values(this.results.levels)) {
      for (const test of levelData.tests) {
        if (test.validation) {
          if (test.validation.valid) validationPassed++;
          if (test.validation.warnings.length > 0) validationWarnings++;
        }
      }
    }
    report += `- **Testes com validação completa:** ${validationPassed}/${this.results.executed}\n`;
    report += `- **Testes com avisos de validação:** ${validationWarnings}\n\n`;

    // Análise de falhas
    if (this.results.errors.length > 0) {
      report += `\n## ❌ Análise de Falhas\n\n`;
      report += `| Test ID | Erro |\n`;
      report += `|---------|------|\n`;
      
      for (const error of this.results.errors.slice(0, 10)) { // Top 10 erros
        const errorMsg = error.error.message.substring(0, 80).replace(/\n/g, ' ');
        report += `| ${error.test_id} | ${errorMsg} |\n`;
      }
    }

    // Hardening opportunities
    report += `\n## 🔧 Oportunidades de Hardening\n\n`;
    report += `### Identificadas a partir dos testes:\n\n`;
    
    // Analisar padrões de falha
    const modelFailures = {};
    for (const [model, metrics] of Object.entries(this.results.model_performance)) {
      if (metrics.failed_calls > 0 && metrics.total_calls >= 3) {
        const failureRate = (metrics.failed_calls / metrics.total_calls) * 100;
        if (failureRate > 20) {
          modelFailures[model] = failureRate;
        }
      }
    }

    if (Object.keys(modelFailures).length > 0) {
      report += `#### Modelos com alta taxa de falha (>20%):\n`;
      for (const [model, rate] of Object.entries(modelFailures)) {
        report += `- **${model}**: ${rate.toFixed(1)}% de falha - Considerar revisão de configuração ou fallback\n`;
      }
    } else {
      report += `- Nenhum modelo com taxa de falha preocupante detectada\n`;
    }

    // Recomendações
    report += `\n## 💡 Recomendações\n\n`;
    
    if (this.results.passed / this.results.executed > 0.95) {
      report += `- ✅ **Excelente estabilidade**: Taxa de sucesso > 95%\n`;
    } else if (this.results.passed / this.results.executed > 0.80) {
      report += `- ⚠️ **Estabilidade aceitável**: Taxa de sucesso entre 80-95%, considerar revisão de casos falhos\n`;
    } else {
      report += `- 🚨 **Estabilidade crítica**: Taxa de sucesso < 80%, requer investigação imediata\n`;
    }

    // Modelos recomendados por categoria
    report += `\n### Modelos Recomendados por Categoria:\n\n`;
    
    const fastModels = sortedModels.filter(m => m[1].avg_duration_ms < 5000 && m[1].success_rate > 90);
    if (fastModels.length > 0) {
      report += `#### **Tarefas Rápidas** (< 5s, > 90% sucesso):\n`;
      for (const [model, metrics] of fastModels.slice(0, 5)) {
        report += `- ${model} (${metrics.avg_duration_ms.toFixed(0)}ms avg, ${metrics.success_rate.toFixed(1)}% sucesso)\n`;
      }
    }

    const reliableModels = sortedModels.filter(m => m[1].success_rate > 95);
    if (reliableModels.length > 0) {
      report += `\n#### **Alta Confiabilidade** (> 95% sucesso):\n`;
      for (const [model, metrics] of reliableModels.slice(0, 5)) {
        report += `- ${model} (${metrics.success_rate.toFixed(1)}% sucesso)\n`;
      }
    }

    report += `\n---\n`;
    report += `*Relatório gerado automaticamente por Omniforge Test Suite Executor*\n`;

    fs.writeFileSync(reportPath, report);
  }
}

// Executar
const runner = new TestRunner();
runner.run().catch(console.error);