import { readFileSync } from "node:fs";
import path from "node:path";

export function loadEnvFile(defaultFileName: string): void {
  const requested = process.env.ENV_FILE?.trim();
  const filePath = requested ? path.resolve(requested) : path.resolve(defaultFileName);
  let text = "";
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  for (const rawLine of text.split(/\r?\n/g)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equals = line.indexOf("=");
    if (equals < 0) {
      continue;
    }
    const key = line.slice(0, equals).trim();
    const value = line.slice(equals + 1).trim();
    if (!key) {
      continue;
    }
    if (process.env[key] === undefined) {
      process.env[key] = stripQuotes(value);
    }
  }
}

function stripQuotes(input: string): string {
  if (
    (input.startsWith("\"") && input.endsWith("\"")) ||
    (input.startsWith("'") && input.endsWith("'"))
  ) {
    return input.slice(1, -1);
  }
  return input;
}
