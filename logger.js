import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
});

// Baileys' own internal logger is very chatty at 'info'/'debug'; default it to
// 'warn' so connection problems still surface without drowning them out.
export const baileysLogger = logger.child(
  { module: 'baileys' },
  { level: process.env.BAILEYS_LOG_LEVEL || 'warn' }
);
