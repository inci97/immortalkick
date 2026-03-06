type Level = "debug" | "info" | "warn" | "error";

const levelWeight: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const envLevel = (process.env.LOG_LEVEL?.toLowerCase() as Level | undefined) ?? "info";
const minLevel = levelWeight[envLevel] ? envLevel : "info";

function write(level: Level, message: string, fields?: Record<string, unknown>): void {
  if (levelWeight[level] < levelWeight[minLevel]) {
    return;
  }
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  };
  const text = JSON.stringify(payload);
  if (level === "error") {
    process.stderr.write(`${text}\n`);
    return;
  }
  process.stdout.write(`${text}\n`);
}

export const logger = {
  debug(message: string, fields?: Record<string, unknown>): void {
    write("debug", message, fields);
  },
  info(message: string, fields?: Record<string, unknown>): void {
    write("info", message, fields);
  },
  warn(message: string, fields?: Record<string, unknown>): void {
    write("warn", message, fields);
  },
  error(message: string, fields?: Record<string, unknown>): void {
    write("error", message, fields);
  },
};
