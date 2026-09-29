import { InternalError, NotFoundError } from "@decaf-ts/db-decorators";

/** Thrown when a node registration or its manifest fails catalogue validation (e.g. invalid ports, unsafe ids, duplicate kinds). */
export class GraphNodeRegistrationError extends InternalError {
  constructor(msg: string | Error | unknown) {
    super(msg, GraphNodeRegistrationError.name, 500);
  }
}

/** Thrown when a node kind is not registered in the backend catalogue. */
export class GraphNodeNotFoundError extends NotFoundError {
  constructor(msg: string | Error | unknown) {
    super(msg);
    this.name = GraphNodeNotFoundError.name;
  }
}

/** Thrown when a declared node method is not registered for a node kind. */
export class GraphNodeMethodNotFoundError extends NotFoundError {
  constructor(msg: string | Error | unknown) {
    super(msg);
    this.name = GraphNodeMethodNotFoundError.name;
  }
}
