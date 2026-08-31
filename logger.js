import pino from 'pino';
import { EventEmitter } from 'node:events';

// Human-readable logs by default (this is a small bot, not a log-aggregation
// pipeline) — set LOG_FORMAT=json to get raw structured JSON instead.
const pretty = process.env.LOG_FORMAT !== 'json';

const LEVEL_NAMES = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

export const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(100);

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: pretty
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' },
      }
    : undefined,
  hooks: {
    logMethod(args, method, level) {
      try {
        const hasObj = args.length >= 2 && args[0] !== null && typeof args[0] === 'object';
        logEmitter.emit('log', {
          level: LEVEL_NAMES[level] ?? 'info',
          time: Date.now(),
          msg: String(hasObj ? args[1] : args[0]) || '',
          data: hasObj ? args[0] : undefined,
        });
      } catch { /* never break logging */ }
      method.apply(this, args);
    },
  },
});

// Baileys' internal logger is silenced to 'fatal' by default: non-fatal errors
// like init-query timeouts are handled gracefully by Baileys itself, and real
// disconnects surface through our own connection.update handler.
export const baileysLogger = logger.child(
  { module: 'baileys' },
  { level: process.env.BAILEYS_LOG_LEVEL || 'fatal' }
);
