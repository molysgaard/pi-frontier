import type { ConversationStateStructure } from "../../__generated__/agent/v1/agent_pb";
import type {
  CheckpointStreamItem,
  ResumeEligibility,
} from "./split-stream";

export interface CheckpointHandler {
  handleCheckpoint(
    ctx: unknown,
    checkpoint: ConversationStateStructure,
    metadata?: { resumeEligibility: ResumeEligibility },
  ): Promise<void>;
  getLatestCheckpoint?: () => ConversationStateStructure | undefined;
}

export class CheckpointController {
  private readonly checkpointStream: AsyncIterable<CheckpointStreamItem>;
  private readonly checkpointHandler: CheckpointHandler;
  private readonly ctx: unknown;

  constructor(
    checkpointStream: AsyncIterable<CheckpointStreamItem>,
    checkpointHandler: CheckpointHandler,
    ctx: unknown,
  ) {
    this.checkpointStream = checkpointStream;
    this.checkpointHandler = checkpointHandler;
    this.ctx = ctx;
  }

  async run(): Promise<void> {
    const ctx = this.ctx;
    const promises: Promise<void>[] = [];
    for await (const item of this.checkpointStream) {
      promises.push(
        this.checkpointHandler.handleCheckpoint(
          ctx,
          item.checkpoint,
          item.metadata,
        ),
      );
    }
    await Promise.all(promises);
  }
}
