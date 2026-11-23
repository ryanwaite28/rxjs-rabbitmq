import type { ClientState } from "./types";

/**
  Base class for every error thrown or rejected by this library,
  so consumers can branch with a single `instanceof` check.
*/
export class RabbitMQClientError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
  The client is not (yet) able to perform the operation, e.g. a publish
  that waited `readyTimeoutMs` without the client reaching `ready`.
*/
export class ClientNotReadyError extends RabbitMQClientError {
  readonly state: ClientState;

  constructor(state: ClientState, message?: string) {
    super(message ?? `RabbitMQ client is not ready (state: ${state})`);
    this.state = state;
  }
}

/**
  The client was closed with `close()` (or gave up reconnecting) and will not
  perform any further broker operations.
*/
export class ClientClosedError extends RabbitMQClientError {
  constructor(message = 'RabbitMQ client is closed') {
    super(message);
  }
}

/**
  `topology: 'verify'` found that a configured queue or exchange does not exist
  (or the user may not access it).
*/
export class TopologyVerificationError extends RabbitMQClientError {
  readonly resourceType: 'queue' | 'exchange';
  readonly resource: string;

  constructor(resourceType: 'queue' | 'exchange', resource: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Topology verification failed: ${resourceType} "${resource}" is missing or not accessible (${reason})`, { cause });
    this.resourceType = resourceType;
    this.resource = resource;
  }
}

/**
  Base class for publish failures. Carries where the message was headed.
*/
export class PublishError extends RabbitMQClientError {
  readonly exchange: string;
  readonly routingKey: string;
  readonly messageId: string | undefined;

  constructor(message: string, target: { exchange: string, routingKey: string, messageId: string | undefined }, options?: { cause?: unknown }) {
    super(message, options);
    this.exchange = target.exchange;
    this.routingKey = target.routingKey;
    this.messageId = target.messageId;
  }
}

/**
  The broker answered the publish with `basic.nack` (e.g. a queue with
  `x-overflow: reject-publish` is full). The message was not stored.
*/
export class PublishNackedError extends PublishError {
  constructor(target: { exchange: string, routingKey: string, messageId: string | undefined }) {
    super(`Broker nacked publish to exchange "${target.exchange}" with routing key "${target.routingKey}"`, target);
  }
}

/**
  A `mandatory` publish could not be routed to any queue, and the broker
  returned it with `basic.return`.
*/
export class PublishReturnedError extends PublishError {
  readonly replyCode: number;
  readonly replyText: string;

  constructor(target: { exchange: string, routingKey: string, messageId: string | undefined }, reply: { replyCode: number, replyText: string }) {
    super(`Broker returned unroutable message published to exchange "${target.exchange}" with routing key "${target.routingKey}": ${reply.replyCode} ${reply.replyText}`, target);
    this.replyCode = reply.replyCode;
    this.replyText = reply.replyText;
  }
}

/**
  The publish channel closed before the broker confirmed the message
  (e.g. `404 NOT_FOUND` for a missing exchange, or connection loss).
  The message may or may not have been stored. `cause` holds the channel error when known.
*/
export class PublishChannelClosedError extends PublishError {
  constructor(target: { exchange: string, routingKey: string, messageId: string | undefined }, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : 'channel closed';
    super(`Publish channel closed before confirm (exchange "${target.exchange}", routing key "${target.routingKey}"): ${reason}`, target, { cause });
  }
}

/**
  `ack`, `nack` or `republish` was called on a delivery that was already settled
  (or is being republished).
*/
export class MessageAlreadySettledError extends RabbitMQClientError {
  constructor(message = 'Message was already acked, nacked, or republished') {
    super(message);
  }
}
