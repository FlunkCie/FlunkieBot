import pino from 'pino';

// Human-readable logs by default (this is a small bot, not a log-aggregation
// pipeline) — set LOG_FORMAT=json to get raw structured JSON instead.
const pretty = process.env.LOG_FORMAT !== 'json';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: pretty
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      }
    : undefined,
});

// Baileys' internal logger is silenced to 'fatal' by default: non-fatal errors
// like init-query timeouts are handled gracefully by Baileys itself, and real
// disconnects surface through our own connection.update handler.
export const baileysLogger = logger.child(
  { module: 'baileys' },
  { level: process.env.BAILEYS_LOG_LEVEL || 'fatal' }
);
