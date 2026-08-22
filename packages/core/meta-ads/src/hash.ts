export function hashCampaignPayload(input: {
  name: string;
  status?: string | null;
  objective?: string | null;
  dailyBudget?: number | null;
  lifetimeBudget?: number | null;
  metrics?: object | null;
}): string {
  const normalized = JSON.stringify({
    name: input.name,
    status: input.status ?? null,
    objective: input.objective ?? null,
    dailyBudget: input.dailyBudget ?? null,
    lifetimeBudget: input.lifetimeBudget ?? null,
    metrics: input.metrics ?? null,
  });
  return fnv1a(normalized);
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
