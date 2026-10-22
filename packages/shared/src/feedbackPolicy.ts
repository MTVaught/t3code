import * as Schema from "effect/Schema";

export const FEEDBACK_UPLOADS_DISABLED_MESSAGE = "Feedback uploads are disabled in Treher.";

export class FeedbackUploadsDisabledError extends Schema.TaggedError<FeedbackUploadsDisabledError>()(
  "FeedbackUploadsDisabledError",
  {},
) {
  override get message(): string {
    return FEEDBACK_UPLOADS_DISABLED_MESSAGE;
  }
}
