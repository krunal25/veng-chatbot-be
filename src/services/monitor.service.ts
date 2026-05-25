/**
 * Query Monitor Service
 * Tracks: response times, query categories, guardrail events, RAG hits,
 * top queries, error rates — all in-memory (no external service needed)
 */

import { Injectable } from '@nestjs/common';

export interface QueryLog {
  id: string;
  sessionId: string;
  conversationId: string;
  userInput: string;
  responseMs: number;
  timestamp: Date;
  category: string; // 'navigation' | 'part-search' | 'faq' | 'rag' | 'fallback' | 'admin'
  guardrailAction: string; // 'allow' | 'block' | 'warn' | 'redact'
  guardrailRule?: string;
  ragUsed: boolean;
  ragScore?: number;
  isEscalated: boolean; // handed to admin
  widgetType?: string;
}

export interface MonitorStats {
  totalQueries: number;
  avgResponseMs: number;
  p95ResponseMs: number;
  p99ResponseMs: number;
  guardrailBlocks: number;
  guardrailWarns: number;
  ragHitRate: number; // %
  escalationRate: number; // %
  queryCategories: Record<string, number>;
  topQueries: Array<{ query: string; count: number }>;
  hourlyVolume: Array<{ hour: string; count: number }>;
  responseTimeBuckets: Array<{ bucket: string; count: number }>;
  recentLogs: QueryLog[];
  guardrailEvents: Array<{ rule: string; count: number }>;
  errorRate: number;
}

@Injectable()
export class QueryMonitorService {
  private logs: QueryLog[] = [];
  private readonly MAX_LOGS = 10000; // ring buffer

  log(entry: Omit<QueryLog, 'id'>): QueryLog {
    const log: QueryLog = { id: this.generateId(), ...entry };

    this.logs.push(log);
    if (this.logs.length > this.MAX_LOGS) {
      this.logs.shift(); // remove oldest
    }

    // Console log for runtime visibility
    const indicator = entry.guardrailAction === 'block' ? '🚫' : entry.ragUsed ? '🔍' : '💬';
    console.log(
      `${indicator} [${entry.responseMs}ms] [${entry.category}] "${entry.userInput.substring(0, 60)}"`,
    );

    return log;
  }

  getStats(windowHours = 24): MonitorStats {
    const since = new Date(Date.now() - windowHours * 3600 * 1000);
    const recent = this.logs.filter((l) => l.timestamp >= since);

    if (recent.length === 0) {
      return this.emptyStats();
    }

    const times = recent.map((l) => l.responseMs).sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)] || 0;
    const p99 = times[Math.floor(times.length * 0.99)] || 0;
    const avgMs = Math.round(times.reduce((a, b) => a + b, 0) / times.length);

    const blocks = recent.filter((l) => l.guardrailAction === 'block').length;
    const warns = recent.filter((l) => l.guardrailAction === 'warn').length;
    const ragHits = recent.filter((l) => l.ragUsed).length;
    const escalated = recent.filter((l) => l.isEscalated).length;

    // Category counts
    const categoryMap: Record<string, number> = {};
    recent.forEach((l) => {
      categoryMap[l.category] = (categoryMap[l.category] || 0) + 1;
    });

    // Top queries (simple text clustering)
    const queryMap: Record<string, number> = {};
    recent.forEach((l) => {
      const key = l.userInput.toLowerCase().trim().substring(0, 40);
      queryMap[key] = (queryMap[key] || 0) + 1;
    });
    const topQueries = Object.entries(queryMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([query, count]) => ({ query, count }));

    // Hourly volume (last 24h)
    const hourlyMap: Record<string, number> = {};
    for (let i = 23; i >= 0; i--) {
      const h = new Date(Date.now() - i * 3600000);
      const key = `${h.getHours().toString().padStart(2, '0')}:00`;
      hourlyMap[key] = 0;
    }
    recent.forEach((l) => {
      const h = new Date(l.timestamp).getHours().toString().padStart(2, '0') + ':00';
      if (hourlyMap[h] !== undefined) hourlyMap[h]++;
    });
    const hourlyVolume = Object.entries(hourlyMap).map(([hour, count]) => ({ hour, count }));

    // Response time buckets
    const buckets = [
      { label: '<100ms', max: 100 },
      { label: '100–300ms', max: 300 },
      { label: '300–600ms', max: 600 },
      { label: '600ms–1s', max: 1000 },
      { label: '>1s', max: Infinity },
    ];
    const responseTimeBuckets = buckets.map(({ label, max }, i) => {
      const min = i === 0 ? 0 : buckets[i - 1].max;
      return { bucket: label, count: times.filter((t) => t >= min && t < max).length };
    });

    // Guardrail events
    const guardrailMap: Record<string, number> = {};
    recent
      .filter((l) => l.guardrailRule)
      .forEach((l) => {
        guardrailMap[l.guardrailRule!] = (guardrailMap[l.guardrailRule!] || 0) + 1;
      });
    const guardrailEvents = Object.entries(guardrailMap)
      .sort((a, b) => b[1] - a[1])
      .map(([rule, count]) => ({ rule, count }));

    return {
      totalQueries: recent.length,
      avgResponseMs: avgMs,
      p95ResponseMs: p95,
      p99ResponseMs: p99,
      guardrailBlocks: blocks,
      guardrailWarns: warns,
      ragHitRate: recent.length > 0 ? Math.round((ragHits / recent.length) * 100) : 0,
      escalationRate: recent.length > 0 ? Math.round((escalated / recent.length) * 100) : 0,
      queryCategories: categoryMap,
      topQueries,
      hourlyVolume,
      responseTimeBuckets,
      recentLogs: this.logs.slice(-50).reverse(),
      guardrailEvents,
      errorRate: 0,
    };
  }

  getRealtimeMetrics() {
    const last5min = new Date(Date.now() - 5 * 60 * 1000);
    const recent = this.logs.filter((l) => l.timestamp >= last5min);
    return {
      qps: (recent.length / 5 / 60).toFixed(2),
      avgMs: recent.length > 0 ? Math.round(recent.reduce((a, b) => a + b.responseMs, 0) / recent.length) : 0,
      activeBlocks: recent.filter((l) => l.guardrailAction === 'block').length,
      ragUsed: recent.filter((l) => l.ragUsed).length,
    };
  }

  private emptyStats(): MonitorStats {
    return {
      totalQueries: 0,
      avgResponseMs: 0,
      p95ResponseMs: 0,
      p99ResponseMs: 0,
      guardrailBlocks: 0,
      guardrailWarns: 0,
      ragHitRate: 0,
      escalationRate: 0,
      queryCategories: {},
      topQueries: [],
      hourlyVolume: [],
      responseTimeBuckets: [],
      recentLogs: [],
      guardrailEvents: [],
      errorRate: 0,
    };
  }

  private generateId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
}
