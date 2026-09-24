export type Suite = 'compile' | 'runtime' | 'criterion';
export interface Measurement { suite: Suite; benchmark: string; compiler: string; metric: string; unit: string; value: number; metadata?: Record<string, unknown>; gate?: boolean; samples?: number[]; lower?: number; upper?: number; }
export interface Run { id: string; project: string; commit: string; branch: string; kind: 'nightly' | 'candidate'; timestamp: string; machine: string; config: string; metadata?: Record<string, unknown>; measurements: Measurement[]; }
export interface ComparisonRow { key: string; suite: Suite; benchmark: string; compiler: string; metric: string; unit: string; baseline: number | null; candidate: number | null; changePercent: number | null; status: 'unchanged' | 'improved' | 'regressed' | 'missing' | 'new'; }
export interface Comparison { status: 'pass' | 'fail' | 'incomparable'; baselineId: string | null; candidateId: string; thresholdPercent: number; rows: ComparisonRow[]; reason?: string; }
