import pino from 'pino'

const logger = pino(
  {
    name: 'nano-cd',
    level: process.env.LOG_LEVEL ?? 'info',
  },
  pino.transport({
    target: 'pino-pretty',
    options: {
      colorize: true,
      singleLine: true,
      translateTime: 'HH:MM:ss.l',
      ignore: 'pid,hostname',
    },
  }),
)
export default logger
