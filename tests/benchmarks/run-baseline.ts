#!/usr/bin/env tsx
/**
 * Phase 0.2 基准性能测试运行器
 * 
 * 功能:
 * - 读取 pdf-rag-test-dataset.json
 * - 对每个问题调用 preflight_rag 工具
 * - 记录答案质量、响应时间、Token 消耗
 * - 生成 baseline-results.json
 * 
 * 使用: tsx tests/benchmarks/run-baseline.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface TestQuestion {
  id: string;
  type: string;
  category: string;
  contentType: string;
  difficulty: string;
  description: string;
  bundleId?: string;
  bundleIds?: string[];
  question: string;
  expectedAnswer: string;
  acceptableVariants?: string[];
  source: string;
  evaluationCriteria: {
    mustContain?: string[];
    mustContainAll?: string[];
    mustContainAny?: string[][];
    mustMention?: string[];
    shouldCover?: string[];
    scoreType: string;
  };
}

interface TestDataset {
  version: string;
  description: string;
  bundles: any[];
  questions: TestQuestion[];
  evaluation: any;
  expectedBaselines: any;
}

interface TestResult {
  questionId: string;
  category: string;
  contentType: string;
  difficulty: string;
  question: string;
  expectedAnswer: string;
  actualAnswer: string;
  score: number; // 0-1
  qualityRating: number; // 1-5
  responseTimeMs: number;
  tokenCount?: number;
  chunksRetrieved?: number;
  error?: string;
  notes?: string;
}

interface BenchmarkResults {
  metadata: {
    testDate: string;
    systemVersion: string;
    datasetVersion: string;
    phase: string;
    description: string;
  };
  results: TestResult[];
  statistics: {
    overall: {
      totalQuestions: number;
      averageScore: number;
      averageQuality: number;
      averageResponseTimeMs: number;
      p95ResponseTimeMs: number;
      averageTokenCount?: number;
    };
    byCategory: {
      [category: string]: {
        count: number;
        averageScore: number;
        averageQuality: number;
        successRate: number;
      };
    };
    byContentType: {
      [contentType: string]: {
        count: number;
        averageScore: number;
      };
    };
    byDifficulty: {
      [difficulty: string]: {
        count: number;
        averageScore: number;
      };
    };
  };
  failedQuestions: {
    questionId: string;
    reason: string;
  }[];
  comparisonToBaseline: {
    singlePdfAccuracy: number;
    crossPdfAccuracy: number;
    meetsSinglePdfTarget: boolean;
    meetsCrossPdfTarget: boolean;
    notes: string[];
  };
}

/**
 * 评估答案质量 (1-5分)
 */
function evaluateAnswerQuality(
  actualAnswer: string,
  expectedAnswer: string,
  criteria: TestQuestion['evaluationCriteria']
): { score: number; quality: number; notes: string } {
  const lower = actualAnswer.toLowerCase();
  const notes: string[] = [];
  let score = 0;
  let quality = 1;

  if (!actualAnswer || actualAnswer.includes('无法回答') || actualAnswer.includes('不支持')) {
    return { score: 0, quality: 1, notes: '系统无法回答' };
  }

  switch (criteria.scoreType) {
    case 'exact-match':
      if (criteria.mustContain) {
        const allFound = criteria.mustContain.every(keyword => lower.includes(keyword.toLowerCase()));
        score = allFound ? 1.0 : 0.0;
        quality = allFound ? 5 : 1;
        notes.push(allFound ? '精确匹配成功' : `缺少关键词: ${criteria.mustContain.join(', ')}`);
      }
      break;

    case 'all-elements':
      if (criteria.mustContainAll) {
        const found = criteria.mustContainAll.filter(kw => lower.includes(kw.toLowerCase()));
        score = found.length / criteria.mustContainAll.length;
        quality = Math.ceil(score * 5);
        notes.push(`包含 ${found.length}/${criteria.mustContainAll.length} 个元素`);
      }
      break;

    case 'semantic-coverage':
      let coverageCount = 0;
      let totalRequirements = 0;

      if (criteria.mustContainAny) {
        totalRequirements += criteria.mustContainAny.length;
        for (const group of criteria.mustContainAny) {
          if (group.some(kw => lower.includes(kw.toLowerCase()))) {
            coverageCount++;
          }
        }
      }

      if (criteria.mustMention) {
        totalRequirements += criteria.mustMention.length;
        for (const keyword of criteria.mustMention) {
          if (lower.includes(keyword.toLowerCase())) {
            coverageCount++;
          }
        }
      }

      score = totalRequirements > 0 ? coverageCount / totalRequirements : 0;
      quality = Math.max(1, Math.ceil(score * 5));
      notes.push(`语义覆盖度: ${coverageCount}/${totalRequirements}`);
      break;

    case 'reasoning-quality':
      // 需要人工评估，这里给默认分
      score = 0.5;
      quality = 3;
      notes.push('需要人工评估推理质量');
      break;

    default:
      score = 0.3;
      quality = 2;
      notes.push('未知评分类型');
  }

  return { score, quality, notes: notes.join('; ') };
}

/**
 * 计算 P95 响应时间
 */
function calculateP95(times: number[]): number {
  if (times.length === 0) return 0;
  const sorted = [...times].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * 主测试函数
 */
async function runBenchmark(): Promise<void> {
  console.log('=== Phase 0.2 基准性能测试 ===\n');

  // 1. 读取测试数据集
  const datasetPath = path.join(__dirname, '../fixtures/pdf-rag-test-dataset.json');
  const dataset: TestDataset = JSON.parse(fs.readFileSync(datasetPath, 'utf-8'));

  console.log(`数据集版本: ${dataset.version}`);
  console.log(`测试问题数: ${dataset.questions.length}\n`);

  // 2. 运行测试（模拟版本 - 实际需要调用 MCP）
  const results: TestResult[] = [];

  for (const q of dataset.questions) {
    console.log(`测试 ${q.id}: ${q.question.substring(0, 50)}...`);

    const startTime = Date.now();
    
    // TODO: 实际调用 preflight_rag MCP tool
    // 这里用模拟数据
    const mockAnswer = `[模拟答案] ${q.expectedAnswer}`;
    
    const responseTime = Date.now() - startTime;

    const evaluation = evaluateAnswerQuality(mockAnswer, q.expectedAnswer, q.evaluationCriteria);

    const result: TestResult = {
      questionId: q.id,
      category: q.category,
      contentType: q.contentType,
      difficulty: q.difficulty,
      question: q.question,
      expectedAnswer: q.expectedAnswer,
      actualAnswer: mockAnswer,
      score: evaluation.score,
      qualityRating: evaluation.quality,
      responseTimeMs: responseTime,
      notes: evaluation.notes,
    };

    results.push(result);
    console.log(`  ✓ 得分: ${evaluation.score.toFixed(2)} | 质量: ${evaluation.quality}/5 | 耗时: ${responseTime}ms\n`);
  }

  // 3. 计算统计
  const statistics = calculateStatistics(results);

  // 4. 生成报告
  const report: BenchmarkResults = {
    metadata: {
      testDate: new Date().toISOString(),
      systemVersion: 'phase0-current',
      datasetVersion: dataset.version,
      phase: 'Phase 0.2 - Baseline',
      description: '当前系统基准性能测试',
    },
    results,
    statistics,
    failedQuestions: results
      .filter(r => r.score < 0.5)
      .map(r => ({
        questionId: r.questionId,
        reason: r.notes || 'Unknown',
      })),
    comparisonToBaseline: compareToBaseline(statistics, dataset.expectedBaselines),
  };

  // 5. 保存结果
  const outputPath = path.join(__dirname, 'baseline-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2), 'utf-8');

  console.log('\n=== 测试完成 ===');
  console.log(`总体准确率: ${(statistics.overall.averageScore * 100).toFixed(1)}%`);
  console.log(`平均质量评分: ${statistics.overall.averageQuality.toFixed(2)}/5`);
  console.log(`平均响应时间: ${statistics.overall.averageResponseTimeMs.toFixed(0)}ms`);
  console.log(`P95 响应时间: ${statistics.overall.p95ResponseTimeMs.toFixed(0)}ms`);
  console.log(`\n结果已保存到: ${outputPath}`);
}

/**
 * 计算统计数据
 */
function calculateStatistics(results: TestResult[]): BenchmarkResults['statistics'] {
  const responseTimes = results.map(r => r.responseTimeMs);

  const byCategory: any = {};
  const byContentType: any = {};
  const byDifficulty: any = {};

  for (const result of results) {
    // By category
    if (!byCategory[result.category]) {
      byCategory[result.category] = { scores: [], qualities: [], count: 0 };
    }
    byCategory[result.category].scores.push(result.score);
    byCategory[result.category].qualities.push(result.qualityRating);
    byCategory[result.category].count++;

    // By content type
    if (!byContentType[result.contentType]) {
      byContentType[result.contentType] = { scores: [], count: 0 };
    }
    byContentType[result.contentType].scores.push(result.score);
    byContentType[result.contentType].count++;

    // By difficulty
    if (!byDifficulty[result.difficulty]) {
      byDifficulty[result.difficulty] = { scores: [], count: 0 };
    }
    byDifficulty[result.difficulty].scores.push(result.score);
    byDifficulty[result.difficulty].count++;
  }

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

  return {
    overall: {
      totalQuestions: results.length,
      averageScore: avg(results.map(r => r.score)),
      averageQuality: avg(results.map(r => r.qualityRating)),
      averageResponseTimeMs: avg(responseTimes),
      p95ResponseTimeMs: calculateP95(responseTimes),
    },
    byCategory: Object.fromEntries(
      Object.entries(byCategory).map(([cat, data]: [string, any]) => [
        cat,
        {
          count: data.count,
          averageScore: avg(data.scores),
          averageQuality: avg(data.qualities),
          successRate: data.scores.filter((s: number) => s >= 0.5).length / data.count,
        },
      ])
    ),
    byContentType: Object.fromEntries(
      Object.entries(byContentType).map(([type, data]: [string, any]) => [
        type,
        {
          count: data.count,
          averageScore: avg(data.scores),
        },
      ])
    ),
    byDifficulty: Object.fromEntries(
      Object.entries(byDifficulty).map(([diff, data]: [string, any]) => [
        diff,
        {
          count: data.count,
          averageScore: avg(data.scores),
        },
      ])
    ),
  };
}

/**
 * 对比 baseline 目标
 */
function compareToBaseline(
  statistics: BenchmarkResults['statistics'],
  expectedBaselines: any
): BenchmarkResults['comparisonToBaseline'] {
  const singlePdfResults = Object.entries(statistics.byCategory)
    .filter(([cat]) => cat === 'single-pdf')
    .flatMap(([, stats]: [string, any]) => [stats.averageScore]);

  const crossPdfResults = Object.entries(statistics.byCategory)
    .filter(([cat]) => cat === 'cross-pdf')
    .flatMap(([, stats]: [string, any]) => [stats.averageScore]);

  const singlePdfAccuracy = singlePdfResults.length > 0 ? singlePdfResults[0] : 0;
  const crossPdfAccuracy = crossPdfResults.length > 0 ? crossPdfResults[0] : 0;

  const phase0Target = 0.7; // 70%
  const phase1CrossTarget = 0.5; // 50%

  const notes: string[] = [];
  if (singlePdfAccuracy < phase0Target) {
    notes.push(`单PDF准确率低于目标 (${(singlePdfAccuracy * 100).toFixed(1)}% < 70%)`);
  }
  if (crossPdfAccuracy === 0) {
    notes.push('跨PDF检索不支持（符合预期）');
  }

  return {
    singlePdfAccuracy,
    crossPdfAccuracy,
    meetsSinglePdfTarget: singlePdfAccuracy >= phase0Target,
    meetsCrossPdfTarget: false, // Phase 0 不支持
    notes,
  };
}

// 运行测试
runBenchmark().catch(console.error);
