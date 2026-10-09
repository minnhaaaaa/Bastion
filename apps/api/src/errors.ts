import type { FastifyError, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { ApiError } from "@bastion/contracts";
import { RecoveryError } from "@bastion/recovery";

type Code = ApiError["error"]["code"];
const STATUS: Record<Code, number> = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  EXPIRED: 410,
  WRONG_PHASE: 409,
  RATE_LIMITED: 429,
  INTERNAL: 500,
};

export class HttpError extends Error {
  constructor(readonly code: Code | "UNAVAILABLE", message: string) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError("NOT_FOUND", `${what} not found`);
export const forbidden = (msg = "not allowed") => new HttpError("FORBIDDEN", msg);

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  let code: Code = "INTERNAL";
  let status = 500;
  let message = "internal error";
  if (err instanceof ZodError) {
    code = "VALIDATION";
    message = err.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
  } else if (err instanceof HttpError || err instanceof RecoveryError) {
    if (err.code === "UNAVAILABLE") {
      code = "INTERNAL";
      status = 503;
    } else code = err.code as Code;
    message = err.message;
  } else if ((err as FastifyError).statusCode === 429) {
    code = "RATE_LIMITED";
    message = err.message;
  } else if ((err as FastifyError).validation || (err as FastifyError).statusCode === 400) {
    code = "VALIDATION";
    message = err.message;
  } else {
    req.log.error(err);
  }
  reply.status(status === 503 ? 503 : STATUS[code]).send({ error: { code, message } } satisfies ApiError);
}
