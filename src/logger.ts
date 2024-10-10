import pino from "pino";

export function makeLogger(level: string) {
  return pino({
    level,
    transport: {
      target: "pino-pretty",
      options: { colorize: true, translateTime: "SYS:standard", ignore: "pid,hostname" },
    },
  });
}

export type Logger = ReturnType<typeof makeLogger>;
