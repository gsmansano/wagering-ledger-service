import { DomainError } from '../shared/domain-error';

export interface InboxMessageState {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
  processedAt: Date | undefined;
}

export type ReceiveInboxProps = Omit<InboxMessageState, 'processedAt'>;

/** Proof that a message was received by a consumer. Uniqueness of (messageId, consumerName) is enforced by the database. */
export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    for (const [name, value] of Object.entries({
      messageId: props.messageId,
      consumerName: props.consumerName,
      payloadHash: props.payloadHash,
    })) {
      if (value.trim() === '') throw new DomainError(`${name} must not be empty`);
    }
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt, undefined);
  }

  /** Rebuilds a persisted message; it was valid when saved, so nothing is re-checked. */
  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new DomainError(`Inbox message ${this.messageId} is already processed`);
    }
    this._processedAt = at;
  }
}
