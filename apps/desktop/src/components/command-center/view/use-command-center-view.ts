import { useReducer, type Dispatch } from "react";
import {
  createCommandCenterViewState,
  reduceCommandCenterView,
  type CommandCenterViewAction,
  type CommandCenterViewState,
} from "./command-center-view";

/**
 * The only React state the command-center surface owns: which local page is
 * open, which workspace was focused last, local drafts and local history.
 * Execution state stays with the Host and its client, so mounting, moving or
 * unmounting this hook cannot change task ownership.
 */
export function useCommandCenterView(initial?: Parameters<typeof createCommandCenterViewState>[0]): {
  readonly view: CommandCenterViewState;
  readonly dispatch: Dispatch<CommandCenterViewAction>;
} {
  const [view, dispatch] = useReducer(reduceCommandCenterView, initial, createCommandCenterViewState);
  return { view, dispatch };
}
