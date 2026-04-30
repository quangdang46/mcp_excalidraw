import logger from './logger.js';
import {
  SyncMetrics,
  PerformanceMetrics,
  HealthMetrics,
} from '../types.js';

const syncMetricsLog: SyncMetrics[] = [];
const performanceMetricsLog: PerformanceMetrics[] = [];
export const MAX_METRICS_LOG_SIZE = 1000;
export const serverStartTime = Date.now();

export function recordSyncMetric(metric: SyncMetrics): void {
  syncMetricsLog.push(metric);
  if (syncMetricsLog.length > MAX_METRICS_LOG_SIZE) {
    syncMetricsLog.shift();
  }
  // Structured log for sync operations
  const logLevel = metric.success ? 'info' : 'error';
  logger[logLevel]('sync_operation', {
    operation: metric.operationType,
    diagramId: metric.diagramId,
    sessionId: metric.sessionId,
    elementCount: metric.elementCount,
    durationMs: metric.durationMs,
    success: metric.success,
    error: metric.error,
  });
}

export function recordPerformanceMetric(metric: PerformanceMetrics): void {
  performanceMetricsLog.push(metric);
  if (performanceMetricsLog.length > MAX_METRICS_LOG_SIZE) {
    performanceMetricsLog.shift();
  }
}

export function getRecentSyncMetrics(limit = 100): SyncMetrics[] {
  return syncMetricsLog.slice(-limit);
}

export function getRecentPerformanceMetrics(limit = 100): PerformanceMetrics[] {
  return performanceMetricsLog.slice(-limit);
}

export function getHealthMetrics(
  clients: Set<unknown>,
  diagramClients: Map<string, Set<unknown>>,
  getElementCount: () => number
): HealthMetrics {
  const heapUsed = process.memoryUsage().heapUsed / 1024 / 1024;
  const issues: string[] = [];

  if (heapUsed > 500) {
    issues.push(`High memory usage: ${Math.round(heapUsed)}MB`);
  }

  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
  let status: HealthMetrics['status'] = 'healthy';
  if (issues.length > 0 || heapUsed > 500) {
    status = 'degraded';
  }
  if (heapUsed > 1000) {
    status = 'unhealthy';
  }

  return {
    status,
    websocketClients: clients.size,
    activeSessions: Array.from(diagramClients.values()).reduce((sum, set) => sum + set.size, 0),
    elementCount: getElementCount(),
    memoryUsageMb: Math.round(heapUsed),
    uptimeSeconds,
    issues,
  };
}
