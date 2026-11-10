import { ContractError } from "./contract";
import { GuardError, IllegalTransitionError } from "./stateMachine";
import { UnsafeUrlError } from "./ssrf";

/** An error whose message is safe to show the person. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** Maps known failures to something the person can read. Unknown errors return null. */
export function toAppError(err: unknown): AppError | null {
  if (err instanceof AppError) return err;
  if (err instanceof ContractError) return new AppError(422, err.message);
  if (err instanceof GuardError) return new AppError(422, err.message);
  if (err instanceof UnsafeUrlError) return new AppError(422, `That URL is not allowed: ${err.message}`);
  if (err instanceof IllegalTransitionError) {
    return new AppError(409, "That action is not available at this stage of the milestone.");
  }
  return null;
}
