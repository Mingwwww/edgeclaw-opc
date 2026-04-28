import { useTranslation } from 'react-i18next';
import type {
  ChangeEvent,
  ClipboardEvent,
  FormEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
  RefObject,
  TouchEvent,
} from 'react';
import { ArrowUp, AtSign, Paperclip, Square } from 'lucide-react';
import type { PendingPermissionRequest } from '../chat/types/types';
import CommandMenu from '../chat/view/subcomponents/CommandMenu';
import PermissionRequestsBanner from '../chat/view/subcomponents/PermissionRequestsBanner';
import ImageAttachment from '../chat/view/subcomponents/ImageAttachment';
import { cn } from '../../lib/utils.js';

interface MentionableFile {
  name: string;
  path: string;
}

interface SlashCommand {
  name: string;
  description?: string;
  namespace?: string;
  path?: string;
  type?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export type ComposerV2Props = {
  input: string;
  placeholder: string;
  textareaRef: RefObject<HTMLTextAreaElement>;
  inputHighlightRef: RefObject<HTMLDivElement>;
  renderInputWithMentions: (text: string) => ReactNode;
  onInputChange: (event: ChangeEvent<HTMLTextAreaElement>) => void;
  onTextareaClick: (event: MouseEvent<HTMLTextAreaElement>) => void;
  onTextareaKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onTextareaPaste: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  onTextareaScrollSync: (target: HTMLTextAreaElement) => void;
  onTextareaInput: (event: FormEvent<HTMLTextAreaElement>) => void;
  onInputFocusChange?: (focused: boolean) => void;
  onSubmit: (
    event:
      | FormEvent<HTMLFormElement>
      | MouseEvent<HTMLButtonElement>
      | TouchEvent<HTMLButtonElement>,
  ) => void;
  onAbortSession: () => void;
  openImagePicker: () => void;
  attachedImages: File[];
  onRemoveImage: (index: number) => void;
  uploadingImages: Map<string, number>;
  imageErrors: Map<string, string>;

  showFileDropdown: boolean;
  filteredFiles: MentionableFile[];
  selectedFileIndex: number;
  onSelectFile: (file: MentionableFile) => void;

  filteredCommands: SlashCommand[];
  selectedCommandIndex: number;
  onCommandSelect: (command: SlashCommand, index: number, isHover: boolean) => void;
  onCloseCommandMenu: () => void;
  isCommandMenuOpen: boolean;
  frequentCommands: SlashCommand[];

  onToggleCommandMenu: () => void;
  getRootProps: (...args: unknown[]) => Record<string, unknown>;
  getInputProps: (...args: unknown[]) => Record<string, unknown>;
  isDragActive: boolean;

  isLoading: boolean;
  canAbortSession: boolean;

  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: {
      allow?: boolean;
      message?: string;
      rememberEntry?: string | null;
      updatedInput?: unknown;
    },
  ) => void;
  handleGrantToolPermission: (suggestion: {
    entry: string;
    toolName: string;
  }) => { success: boolean };

  sendByCtrlEnter?: boolean;

  /**
   * When true, the outer "footer" chrome (top divider, page bg, page padding)
   * is suppressed so this composer can be embedded inside a centered card —
   * notably the Agent welcome state. The inner rounded textarea card is the
   * only border in that mode, avoiding the doubled-divider artifact.
   */
  chromeless?: boolean;
};

export default function ComposerV2({
  input,
  placeholder,
  textareaRef,
  inputHighlightRef,
  renderInputWithMentions,
  onInputChange,
  onTextareaClick,
  onTextareaKeyDown,
  onTextareaPaste,
  onTextareaScrollSync,
  onTextareaInput,
  onInputFocusChange,
  onSubmit,
  onAbortSession,
  openImagePicker,
  attachedImages,
  onRemoveImage,
  uploadingImages,
  imageErrors,
  showFileDropdown,
  filteredFiles,
  selectedFileIndex,
  onSelectFile,
  filteredCommands,
  selectedCommandIndex,
  onCommandSelect,
  onCloseCommandMenu,
  isCommandMenuOpen,
  frequentCommands,
  onToggleCommandMenu,
  getRootProps,
  getInputProps,
  isDragActive,
  isLoading,
  canAbortSession,
  pendingPermissionRequests,
  handlePermissionDecision,
  handleGrantToolPermission,
  chromeless = false,
}: ComposerV2Props) {
  const { t } = useTranslation('chat');

  const hasQuestionPanel = pendingPermissionRequests.some(
    (r) => r.toolName === 'AskUserQuestion',
  );

  const textareaRect = textareaRef.current?.getBoundingClientRect();
  const commandMenuPosition = {
    top: textareaRect ? Math.max(16, textareaRect.top - 316) : 0,
    left: textareaRect ? textareaRect.left : 16,
    bottom: textareaRect ? window.innerHeight - textareaRect.top + 8 : 90,
  };

  const disabled = !input.trim() && !(isLoading && canAbortSession);

  return (
    <div
      className={cn(
        'shrink-0',
        // No top divider — the rounded textarea card is the only border, giving
        // the composer a flat ChatGPT-style look. Keeps page bg + padding so
        // it still anchors the bottom of the chat surface.
        chromeless ? '' : 'bg-white px-6 pb-6 pt-3 dark:bg-neutral-950',
      )}
    >
      <div className={cn(chromeless ? '' : 'mx-auto max-w-[720px]')}>
        {pendingPermissionRequests.length > 0 ? (
          <div className="mb-3">
            <PermissionRequestsBanner
              pendingPermissionRequests={pendingPermissionRequests}
              handlePermissionDecision={handlePermissionDecision}
              handleGrantToolPermission={handleGrantToolPermission}
            />
          </div>
        ) : null}

        {!hasQuestionPanel ? (
          <form
            onSubmit={onSubmit as (event: FormEvent<HTMLFormElement>) => void}
            className="relative"
          >
            {attachedImages.length > 0 ? (
              <div className="mb-2 rounded-lg border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900">
                <div className="flex flex-wrap gap-2">
                  {attachedImages.map((file, index) => (
                    <ImageAttachment
                      key={index}
                      file={file}
                      onRemove={() => onRemoveImage(index)}
                      uploadProgress={uploadingImages.get(file.name)}
                      error={imageErrors.get(file.name)}
                    />
                  ))}
                </div>
              </div>
            ) : null}

            {showFileDropdown && filteredFiles.length > 0 ? (
              <div className="absolute bottom-full left-0 right-0 z-50 mb-2 max-h-48 overflow-y-auto rounded-lg border border-neutral-200 bg-white shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
                {filteredFiles.map((file, index) => (
                  <div
                    key={file.path}
                    className={cn(
                      'cursor-pointer border-b border-neutral-100 px-3 py-2 text-[13px] last:border-b-0 dark:border-neutral-800',
                      index === selectedFileIndex
                        ? 'bg-neutral-100 dark:bg-neutral-800'
                        : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/60',
                    )}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onSelectFile(file);
                    }}
                  >
                    <div className="font-medium">{file.name}</div>
                    <div className="font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
                      {file.path}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}

            <CommandMenu
              commands={filteredCommands}
              selectedIndex={selectedCommandIndex}
              onSelect={onCommandSelect}
              onClose={onCloseCommandMenu}
              position={commandMenuPosition}
              isOpen={isCommandMenuOpen}
              frequentCommands={frequentCommands}
            />

            <div
              {...getRootProps()}
              className={cn(
                'group rounded-xl border bg-white p-2 shadow-sm transition-colors',
                'border-neutral-200 focus-within:border-neutral-300',
                'dark:border-neutral-800 dark:bg-neutral-900 dark:focus-within:border-neutral-700',
                isDragActive && 'border-dashed border-neutral-400 dark:border-neutral-500',
              )}
            >
              <input {...getInputProps()} />

              <div className="relative">
                <div
                  ref={inputHighlightRef}
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 overflow-hidden"
                >
                  <div className="block w-full whitespace-pre-wrap break-words px-2 pt-1.5 text-[14px] leading-6 text-transparent">
                    {renderInputWithMentions(input)}
                  </div>
                </div>
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={onInputChange}
                  onClick={onTextareaClick}
                  onKeyDown={onTextareaKeyDown}
                  onPaste={onTextareaPaste}
                  onScroll={(event) =>
                    onTextareaScrollSync(event.target as HTMLTextAreaElement)
                  }
                  onFocus={() => onInputFocusChange?.(true)}
                  onBlur={() => onInputFocusChange?.(false)}
                  onInput={onTextareaInput}
                  placeholder={placeholder}
                  rows={2}
                  className="relative z-10 block max-h-[40vh] min-h-[48px] w-full resize-none bg-transparent px-2 pt-1.5 text-[14px] leading-6 text-neutral-900 placeholder-neutral-400 outline-none dark:text-neutral-100 dark:placeholder-neutral-500"
                />
              </div>

              <div className="flex items-center justify-between px-1 pt-1">
                <div className="flex items-center gap-0.5">
                  <button
                    type="button"
                    onClick={openImagePicker}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                    title={t('input.attachImages', { defaultValue: 'Attach file' }) as string}
                  >
                    <Paperclip className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                  <button
                    type="button"
                    onClick={onToggleCommandMenu}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-500 transition hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                    title={t('input.mentionFile', { defaultValue: 'Mention a file' }) as string}
                  >
                    <AtSign className="h-4 w-4" strokeWidth={1.75} />
                  </button>
                </div>

                {isLoading && canAbortSession ? (
                  <button
                    type="button"
                    onClick={onAbortSession}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-red-500 text-white transition hover:bg-red-600"
                    title={t('input.stop', { defaultValue: 'Stop' }) as string}
                  >
                    <Square className="h-3.5 w-3.5" strokeWidth={2.5} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    type="submit"
                    disabled={disabled}
                    onMouseDown={(event) => {
                      if (disabled) return;
                      event.preventDefault();
                      onSubmit(event);
                    }}
                    onTouchStart={(event) => {
                      if (disabled) return;
                      event.preventDefault();
                      onSubmit(event);
                    }}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-900 text-white transition hover:opacity-90 disabled:opacity-40 dark:bg-neutral-50 dark:text-neutral-900"
                    title={t('input.send', { defaultValue: 'Send' }) as string}
                  >
                    <ArrowUp className="h-4 w-4" strokeWidth={2} />
                  </button>
                )}
              </div>
            </div>
          </form>
        ) : null}
      </div>
    </div>
  );
}
