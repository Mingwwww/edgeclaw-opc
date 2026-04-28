import { useCallback, useRef } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ChatMessage,
  ClaudePermissionSuggestion,
  PermissionGrantResult,
} from '../chat/types/types';
import type { Project, ProjectSession, SessionProvider } from '../../types/app';
import { getIntrinsicMessageKey } from '../chat/utils/messageKeys';
import MessageRowV2 from './MessageRowV2';

type DiffLine = { type: string; content: string; lineNum: number };

type MessagesPaneV2Props = {
  scrollContainerRef: RefObject<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  chatMessages: ChatMessage[];
  visibleMessages: ChatMessage[];
  visibleMessageCount: number;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  loadEarlierMessages: () => void;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  provider: SessionProvider;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantToolPermission?: (
    suggestion: ClaudePermissionSuggestion,
  ) => PermissionGrantResult | null | undefined;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  setInput: Dispatch<SetStateAction<string>>;
};

export default function MessagesPaneV2({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  chatMessages,
  visibleMessages,
  visibleMessageCount,
  isLoadingMoreMessages,
  hasMoreMessages,
  totalMessages,
  loadEarlierMessages,
  loadAllMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  provider,
  selectedProject,
  selectedSession: _selectedSession,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantToolPermission,
  autoExpandTools,
  showRawParameters,
  showThinking,
  setInput,
}: MessagesPaneV2Props) {
  const { t } = useTranslation();
  const messageKeyMapRef = useRef<WeakMap<ChatMessage, string>>(new WeakMap());
  const allocatedKeysRef = useRef<Set<string>>(new Set());
  const generatedMessageKeyCounterRef = useRef(0);

  const getMessageKey = useCallback((message: ChatMessage) => {
    const existingKey = messageKeyMapRef.current.get(message);
    if (existingKey) return existingKey;

    const intrinsicKey = getIntrinsicMessageKey(message);
    let candidateKey = intrinsicKey;

    if (!candidateKey || allocatedKeysRef.current.has(candidateKey)) {
      do {
        generatedMessageKeyCounterRef.current += 1;
        candidateKey = intrinsicKey
          ? `${intrinsicKey}-${generatedMessageKeyCounterRef.current}`
          : `message-generated-${generatedMessageKeyCounterRef.current}`;
      } while (allocatedKeysRef.current.has(candidateKey));
    }

    allocatedKeysRef.current.add(candidateKey);
    messageKeyMapRef.current.set(message, candidateKey);
    return candidateKey;
  }, []);

  const suggestedPrompts: string[] = [
    t('emptyChat.prompts.plan', { defaultValue: 'Plan a refactor for this project' }),
    t('emptyChat.prompts.summary', { defaultValue: 'Summarize recent changes' }),
    t('emptyChat.prompts.review', { defaultValue: 'Review the most recent file I touched' }),
  ];

  const isEmpty = !isLoadingSessionMessages && chatMessages.length === 0;

  return (
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      className="relative flex-1 overflow-y-auto overflow-x-hidden bg-white dark:bg-neutral-950"
    >
      {isLoadingSessionMessages && chatMessages.length === 0 ? (
        <div className="mx-auto flex h-full max-w-[720px] items-center justify-center px-6 py-10 text-[13px] text-neutral-500 dark:text-neutral-400">
          <div className="flex items-center gap-2">
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-b-2 border-neutral-400" />
            <span>{t('loading', { defaultValue: 'Loading…' })}</span>
          </div>
        </div>
      ) : isEmpty ? (
        <div className="mx-auto flex h-full max-w-[720px] flex-col items-center justify-center gap-4 px-6 py-10 text-center">
          <div className="text-[15px] font-medium text-neutral-900 dark:text-neutral-100">
            {selectedProject
              ? t('emptyChat.title', { defaultValue: 'Start a new conversation' })
              : t('emptyChat.noProject', { defaultValue: 'Pick a project from the sidebar' })}
          </div>
          {selectedProject ? (
            <div className="flex flex-col gap-1.5">
              {suggestedPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setInput(prompt)}
                  className="rounded-lg border border-neutral-200 px-3 py-1.5 text-left text-[13px] text-neutral-700 transition hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
                >
                  {prompt}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="mx-auto max-w-[860px] space-y-8 px-6 py-10">
          {/* Loading older messages indicator */}
          {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded ? (
            <div className="py-3 text-center text-[12px] text-neutral-500 dark:text-neutral-400">
              {t('messages.loadingOlder', { defaultValue: 'Loading older messages…' })}
            </div>
          ) : null}

          {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded ? (
            <div className="flex items-center justify-between border-b border-neutral-200 pb-3 text-[12px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              <span>
                {t('messages.showingOf', {
                  shown: chatMessages.length,
                  total: totalMessages,
                  defaultValue: `Showing ${chatMessages.length} of ${totalMessages}`,
                })}
              </span>
              <button
                type="button"
                onClick={loadEarlierMessages}
                className="text-[12px] text-neutral-700 underline-offset-2 hover:underline dark:text-neutral-300"
              >
                {t('messages.loadEarlier', { defaultValue: 'Load earlier' })}
              </button>
            </div>
          ) : null}

          {!hasMoreMessages && chatMessages.length > visibleMessageCount ? (
            <div className="flex items-center justify-between border-b border-neutral-200 pb-3 text-[12px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              <span>
                {t('messages.showingLast', {
                  count: visibleMessageCount,
                  total: chatMessages.length,
                  defaultValue: `Showing last ${visibleMessageCount} of ${chatMessages.length}`,
                })}
              </span>
              <button
                type="button"
                onClick={loadAllMessages}
                className="text-[12px] text-neutral-700 underline-offset-2 hover:underline dark:text-neutral-300"
              >
                {t('messages.loadAll', { defaultValue: 'Load all' })}
              </button>
            </div>
          ) : null}

          {visibleMessages.map((message, index) => {
            const prevMessage = index > 0 ? visibleMessages[index - 1] : null;
            return (
              <MessageRowV2
                key={getMessageKey(message)}
                message={message}
                prevMessage={prevMessage}
                provider={provider}
                selectedProject={selectedProject}
                createDiff={createDiff}
                onFileOpen={onFileOpen}
                onShowSettings={onShowSettings}
                onGrantToolPermission={onGrantToolPermission}
                autoExpandTools={autoExpandTools}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
