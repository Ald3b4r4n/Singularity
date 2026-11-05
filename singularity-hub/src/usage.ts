/** Only numeric fields explicitly reported by the CLI may reach session metrics. */
export function reportedUsage(raw: unknown, costUsd?: unknown): { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; costUsd?: number } | undefined {
	const result: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; costUsd?: number } = {};
	const usage = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
	for (const [source, target] of [['input_tokens', 'inputTokens'], ['output_tokens', 'outputTokens'], ['cached_input_tokens', 'cachedInputTokens']] as const) {
		const value = usage[source];
		if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) { result[target] = value; }
	}
	if (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd >= 0) { result.costUsd = costUsd; }
	return Object.keys(result).length ? result : undefined;
}
