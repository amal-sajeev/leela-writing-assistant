/**
 * Logging (specification section 58).
 *
 * Fields are restricted to primitives so that document text, prompts, vault
 * excerpts and API keys cannot be logged by accident. Content logging requires
 * a separate, explicit developer toggle and is not implemented here.
 */

export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

export type LogField = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogField>;

export interface LogSink {
  error(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  debug(message: string, fields?: LogFields): void;
}

const consoleSink: LogSink = {
  error: (message, fields) => console.error(message, fields ?? ""),
  warn: (message, fields) => console.warn(message, fields ?? ""),
  info: (message, fields) => console.warn(message, fields ?? ""),
  debug: (message, fields) => console.warn(message, fields ?? ""),
};

export class Logger {
  private level: LogLevel;

  constructor(
    private readonly prefix: string,
    level: LogLevel = "warn",
    private readonly sink: LogSink = consoleSink,
  ) {
    this.level = level;
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  child(scope: string): Logger {
    return new Logger(`${this.prefix}:${scope}`, this.level, this.sink);
  }

  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] > LEVEL_RANK[this.level]) return;
    this.sink[level](`[${this.prefix}] ${message}`, fields);
  }
}

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}
