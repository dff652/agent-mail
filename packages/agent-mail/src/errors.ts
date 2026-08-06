export class AgentMailError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "AgentMailError";
    this.exitCode = exitCode;
  }
}

export class TaskTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskTransitionError";
  }
}

/**
 * A task carrying a human approval cannot reach `completed` until that approval
 * is `approved`. Surfaces as exit code 6 / HTTP 403 (PROTOCOL 4.3 and 9).
 */
export class ApprovalRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalRequiredError";
  }
}
