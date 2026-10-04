import type { RuntimeStatusValue } from "@/features/dashboard/types";

export type SessionMessageAction = "send" | "steer";

/** Match runtime capabilities without changing the meaning of a failed retry. */
export function sessionMessageAction({
  status,
  canSendMessage,
  canSteer,
  retryAction,
}: {
  status: RuntimeStatusValue;
  canSendMessage: boolean;
  canSteer: boolean;
  retryAction?: SessionMessageAction;
}): SessionMessageAction | null {
  let action: SessionMessageAction | null = null;
  if ((status === "idle" || status === "error") && canSendMessage) {
    action = "send";
  } else if (status === "running" && canSteer) {
    action = "steer";
  }
  return retryAction && retryAction !== action ? null : action;
}
