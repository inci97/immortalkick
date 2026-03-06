export function getEnv(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function getOptionalEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return undefined;
  }
  return value;
}

export function getIntEnv(name: string, fallback?: number): number {
  const raw = process.env[name] ?? (fallback !== undefined ? String(fallback) : undefined);
  if (raw === undefined) {
    throw new Error(`Missing required integer environment variable: ${name}`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || Number.isNaN(value)) {
    throw new Error(`Invalid integer value for ${name}: ${raw}`);
  }
  return value;
}

export function maskSecret(secret: string): string {
  if (secret.length <= 8) {
    return "********";
  }
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}
