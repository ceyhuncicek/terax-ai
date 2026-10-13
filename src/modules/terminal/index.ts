export {
  type AgentTabStatus,
  tabAgentStatus,
  useAgentActivityStore,
} from "./lib/agentActivity";
export { joinSelectionToSingleLine } from "./lib/joinSelectionToSingleLine";
export {
  fileLinkOpenPayload,
  OPEN_FILE_AT_EVENT,
  type OpenFileAtPayload,
} from "./lib/openFileAt";
export {
  type ClaudeSessionLink,
  findLeaf,
  findLeafCwd,
  hasLeaf,
  isLeaf,
  leafIds,
  type PaneBounds,
  type PaneId,
  type PaneNode,
  type SplitDir,
} from "./lib/panes";
export { writeTerminalClipboard } from "./lib/terminalClipboard";
export {
  clearFocusedTerminal,
  disposeSession,
  leafHasForegroundProcess,
  leafIdForPty,
  navigateFocusedBlocks,
  ptyIdForLeaf,
  respawnSession,
  whenSessionReady,
  writeToSession,
} from "./lib/terminalSessionApi";
export { isTerminalSurfaceTarget } from "./lib/terminalSurfaceTarget";
export {
  type TerminalPathDropTarget,
  useTerminalFileDrop,
} from "./lib/useTerminalFileDrop";
export { TerminalPane, type TerminalPaneHandle } from "./TerminalPane";
export { TerminalStack } from "./TerminalStack";
