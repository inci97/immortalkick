const ALLOWED_VOTES = new Set(["1", "2", "3", "#1", "#2", "#3"]);

export function normalizeVoteToken(input: string): string | null {
  const trimmed = input.trim();
  if (ALLOWED_VOTES.has(trimmed)) {
    return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  }
  return null;
}

export function isVoteToken(input: string): boolean {
  return normalizeVoteToken(input) !== null;
}
