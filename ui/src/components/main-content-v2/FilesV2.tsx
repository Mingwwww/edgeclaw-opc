import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ClipboardCopy,
  FilePlus,
  Folder,
  FolderOpen,
  FolderPlus,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import type { Project } from '../../types/app';
import { useFileTreeData } from '../file-tree/hooks/useFileTreeData';
import type { FileTreeNode } from '../file-tree/types/types';
import { getFileIconData } from '../file-tree/constants/fileIcons';
import { cn } from '../../lib/utils.js';
import { api } from '../../utils/api';

type FilesV2Props = {
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
  onClose?: () => void;
};

type FlattenedNode = {
  node: FileTreeNode;
  depth: number;
  parentPath: string;
};

type FileContextMenu = {
  node: FileTreeNode | null;
  x: number;
  y: number;
};

type InlineEdit =
  | { kind: 'rename'; path: string; currentName: string; depth: number }
  | { kind: 'create'; parentPath: string; type: 'file' | 'directory'; depth: number };

const CONTEXT_MENU_WIDTH = 180;
const CONTEXT_MENU_HEIGHT = 200;
const CONTEXT_MENU_MARGIN = 8;

function clampMenuPosition(x: number, y: number) {
  const maxX = window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN;
  const maxY = window.innerHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_MARGIN;
  return {
    x: Math.max(CONTEXT_MENU_MARGIN, Math.min(x, maxX)),
    y: Math.max(CONTEXT_MENU_MARGIN, Math.min(y, maxY)),
  };
}

function flatten(
  nodes: FileTreeNode[],
  expanded: Set<string>,
  depth = 0,
  parentPath = '',
): FlattenedNode[] {
  const out: FlattenedNode[] = [];
  for (const node of nodes) {
    out.push({ node, depth, parentPath });
    if (node.type === 'directory' && expanded.has(node.path) && node.children) {
      out.push(...flatten(node.children, expanded, depth + 1, node.path));
    }
  }
  return out;
}

export default function FilesV2({ selectedProject, onFileOpen, onClose }: FilesV2Props) {
  const { t } = useTranslation();
  const { files, loading, refreshFiles } = useFileTreeData(selectedProject);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<FileContextMenu | null>(null);
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
  const inlineInputRef = useRef<HTMLInputElement>(null);
  const escapePressedRef = useRef(false);

  useEffect(() => {
    setExpanded(new Set());
    setActivePath(null);
    setContextMenu(null);
    setInlineEdit(null);
  }, [selectedProject?.name]);

  const flat = useMemo(() => flatten(files, expanded), [files, expanded]);

  const projectName = selectedProject?.name ?? '';

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  const handleClick = useCallback(
    (node: FileTreeNode) => {
      setActivePath(node.path);
      if (node.type === 'directory') {
        toggle(node.path);
        return;
      }
      onFileOpen?.(node.path);
    },
    [onFileOpen, toggle],
  );

  // --- Context menu ---

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleContextMenu = useCallback(
    (event: ReactMouseEvent, node: FileTreeNode) => {
      event.preventDefault();
      event.stopPropagation();
      const pos = clampMenuPosition(event.clientX, event.clientY);
      setContextMenu({ node, x: pos.x, y: pos.y });
    },
    [],
  );

  const handleBlankContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if ((event.target as HTMLElement).closest('li')) return;
      event.preventDefault();
      const pos = clampMenuPosition(event.clientX, event.clientY);
      setContextMenu({ node: null, x: pos.x, y: pos.y });
    },
    [],
  );

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = () => closeContextMenu();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    window.addEventListener('click', dismiss);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', dismiss);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu, closeContextMenu]);

  // --- Inline edit ---

  useEffect(() => {
    if (inlineEdit && inlineInputRef.current) {
      inlineInputRef.current.focus();
      if (inlineEdit.kind === 'rename') {
        const dotIdx = inlineEdit.currentName.lastIndexOf('.');
        const end = dotIdx > 0 ? dotIdx : inlineEdit.currentName.length;
        inlineInputRef.current.setSelectionRange(0, end);
      } else {
        inlineInputRef.current.select();
      }
    }
  }, [inlineEdit]);

  const commitInlineEdit = useCallback(
    async (value: string) => {
      if (!selectedProject || !inlineEdit) return;
      const trimmed = value.trim();
      if (!trimmed) {
        setInlineEdit(null);
        return;
      }

      try {
        if (inlineEdit.kind === 'rename') {
          if (trimmed === inlineEdit.currentName) {
            setInlineEdit(null);
            return;
          }
          await api.renameFile(projectName, {
            oldPath: inlineEdit.path,
            newName: trimmed,
          });
        } else {
          const parentPath = inlineEdit.parentPath || '';
          await api.createFile(projectName, {
            path: parentPath || undefined,
            type: inlineEdit.type,
            name: trimmed,
          });
          if (parentPath) {
            setExpanded((prev) => {
              const next = new Set(prev);
              next.add(parentPath);
              return next;
            });
          }
        }
        await refreshFiles();
      } catch (error) {
        console.error('File operation failed:', error);
      }
      setInlineEdit(null);
    },
    [inlineEdit, projectName, refreshFiles, selectedProject],
  );

  const handleInlineKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitInlineEdit(event.currentTarget.value);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        escapePressedRef.current = true;
        setInlineEdit(null);
      }
    },
    [commitInlineEdit],
  );

  const handleInlineBlur = useCallback(
    (event: React.FocusEvent<HTMLInputElement>) => {
      if (escapePressedRef.current) {
        escapePressedRef.current = false;
        setInlineEdit(null);
        return;
      }
      commitInlineEdit(event.currentTarget.value);
    },
    [commitInlineEdit],
  );

  // --- Menu actions ---

  const handleNewFile = useCallback(
    (parentPath: string, depth: number) => {
      closeContextMenu();
      if (parentPath) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.add(parentPath);
          return next;
        });
      }
      setInlineEdit({ kind: 'create', parentPath, type: 'file', depth });
    },
    [closeContextMenu],
  );

  const handleNewFolder = useCallback(
    (parentPath: string, depth: number) => {
      closeContextMenu();
      if (parentPath) {
        setExpanded((prev) => {
          const next = new Set(prev);
          next.add(parentPath);
          return next;
        });
      }
      setInlineEdit({ kind: 'create', parentPath, type: 'directory', depth });
    },
    [closeContextMenu],
  );

  const handleRename = useCallback(
    (node: FileTreeNode, depth: number) => {
      closeContextMenu();
      setInlineEdit({ kind: 'rename', path: node.path, currentName: node.name, depth });
    },
    [closeContextMenu],
  );

  const handleDelete = useCallback(
    async (node: FileTreeNode) => {
      closeContextMenu();
      if (!selectedProject) return;
      const confirmed = window.confirm(
        `Delete "${node.name}"?${node.type === 'directory' ? ' This will delete all contents.' : ''}`,
      );
      if (!confirmed) return;
      try {
        await api.deleteFile(projectName, {
          path: node.path,
          type: node.type === 'directory' ? 'directory' : 'file',
        });
        await refreshFiles();
      } catch (error) {
        console.error('Delete failed:', error);
      }
    },
    [closeContextMenu, projectName, refreshFiles, selectedProject],
  );

  const handleCopyPath = useCallback(
    (node: FileTreeNode) => {
      closeContextMenu();
      navigator.clipboard.writeText(node.path).catch(() => {});
    },
    [closeContextMenu],
  );

  const handleOpen = useCallback(
    (node: FileTreeNode) => {
      closeContextMenu();
      onFileOpen?.(node.path);
    },
    [closeContextMenu, onFileOpen],
  );

  // --- Depth lookup for context menu target ---

  const depthByPath = useMemo(() => {
    const map = new Map<string, number>();
    for (const { node, depth } of flat) {
      map.set(node.path, depth);
    }
    return map;
  }, [flat]);

  // --- Render ---

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-[13px] text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        {t('fileTree.selectProject', { defaultValue: 'Pick a project to browse files.' })}
      </div>
    );
  }

  const cwd = selectedProject.fullPath || selectedProject.path || selectedProject.name;
  const hasExpanded = expanded.size > 0;

  const menuItemClass = cn(
    'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] transition-colors',
    'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
  );
  const menuIconClass = 'h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400';

  const renderInlineInput = (depth: number) => (
    <li
      key="__inline_edit__"
      style={{ marginLeft: `${depth * 20}px` }}
      className="flex items-center gap-2 rounded-md px-1.5 py-0.5"
    >
      <span className="w-3.5" />
      {inlineEdit?.kind === 'create' && inlineEdit.type === 'directory' ? (
        <Folder className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
      ) : inlineEdit?.kind === 'create' ? (
        <FilePlus className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
      ) : null}
      <input
        ref={inlineInputRef}
        defaultValue={inlineEdit?.kind === 'rename' ? inlineEdit.currentName : ''}
        onKeyDown={handleInlineKeyDown}
        onBlur={handleInlineBlur}
        className={cn(
          'min-w-0 flex-1 rounded border px-1.5 py-0.5 text-[13px] outline-none',
          'border-blue-400 bg-white text-neutral-900 focus:ring-1 focus:ring-blue-400',
          'dark:border-blue-500 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:ring-blue-500',
        )}
      />
    </li>
  );

  const findInsertIndex = (parentPath: string): number => {
    if (!parentPath) return flat.length;
    const parentIdx = flat.findIndex((f) => f.node.path === parentPath);
    if (parentIdx === -1) return flat.length;
    const parentDepth = flat[parentIdx].depth;
    let i = parentIdx + 1;
    while (i < flat.length && flat[i].depth > parentDepth) i++;
    return i;
  };

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-950">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-200 px-6 dark:border-neutral-800">
        <span className="truncate font-mono text-xxs text-neutral-500 dark:text-neutral-400">
          {cwd}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => handleNewFile('', 0)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
            title={t('fileTree.context.newFile', { defaultValue: 'New File' }) as string}
            aria-label={t('fileTree.context.newFile', { defaultValue: 'New File' }) as string}
          >
            <FilePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => handleNewFolder('', 0)}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
            title={t('fileTree.context.newFolder', { defaultValue: 'New Folder' }) as string}
            aria-label={t('fileTree.context.newFolder', { defaultValue: 'New Folder' }) as string}
          >
            <FolderPlus className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={refreshFiles}
            disabled={loading}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-900"
            title={t('fileTree.refresh', { defaultValue: 'Refresh' }) as string}
            aria-label={t('fileTree.refresh', { defaultValue: 'Refresh' }) as string}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={collapseAll}
            disabled={!hasExpanded}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-900"
            title={t('fileTree.collapseAll', { defaultValue: 'Collapse all' }) as string}
            aria-label={t('fileTree.collapseAll', { defaultValue: 'Collapse all' }) as string}
          >
            <ChevronsDownUp className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
          {onClose ? (
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-neutral-600 transition hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-900"
              title={t('fileTree.close', { defaultValue: 'Close file tree' }) as string}
              aria-label={t('fileTree.close', { defaultValue: 'Close file tree' }) as string}
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          ) : null}
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto py-2 text-[13px]"
        onContextMenu={handleBlankContextMenu}
      >
        {loading && files.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-6 text-xxs text-neutral-500 dark:text-neutral-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
            <span>{t('loading', { defaultValue: 'Loading…' })}</span>
          </div>
        ) : flat.length === 0 ? (
          <div className="py-6 text-center text-xxs text-neutral-500 dark:text-neutral-400">
            {t('fileTree.empty', { defaultValue: 'This project is empty.' })}
          </div>
        ) : (
          <ul className="space-y-0.5 px-4">
            {flat.map(({ node, depth }, idx) => {
              const isDir = node.type === 'directory';
              const isOpen = isDir && expanded.has(node.path);
              const isActive = activePath === node.path;
              const isRenaming = inlineEdit?.kind === 'rename' && inlineEdit.path === node.path;

              let Icon = Folder;
              let color = 'text-neutral-500 dark:text-neutral-400';
              if (isDir) {
                Icon = isOpen ? FolderOpen : Folder;
              } else {
                const iconData = getFileIconData(node.name);
                Icon = iconData.icon;
                color = iconData.color;
              }

              const showCreateAfter =
                inlineEdit?.kind === 'create' &&
                findInsertIndex(inlineEdit.parentPath) === idx + 1;

              return (
                <li
                  key={node.path}
                  onContextMenu={(event) => handleContextMenu(event, node)}
                >
                  {isRenaming ? (
                    <div
                      style={{ marginLeft: `${depth * 20}px` }}
                      className="flex items-center gap-2 rounded-md px-1.5 py-0.5"
                    >
                      {isDir ? (
                        <ChevronRight className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
                      ) : (
                        <span className="w-3.5" />
                      )}
                      <Icon className={cn('h-3.5 w-3.5 shrink-0', color)} strokeWidth={1.75} />
                      <input
                        ref={inlineInputRef}
                        defaultValue={inlineEdit.currentName}
                        onKeyDown={handleInlineKeyDown}
                        onBlur={handleInlineBlur}
                        className={cn(
                          'min-w-0 flex-1 rounded border px-1.5 py-0.5 text-[13px] outline-none',
                          'border-blue-400 bg-white text-neutral-900 focus:ring-1 focus:ring-blue-400',
                          'dark:border-blue-500 dark:bg-neutral-900 dark:text-neutral-100 dark:focus:ring-blue-500',
                        )}
                      />
                    </div>
                  ) : (
                    <div
                      onClick={() => handleClick(node)}
                      style={{ marginLeft: `${depth * 20}px` }}
                      className={cn(
                        'flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 transition-colors',
                        isActive
                          ? 'bg-neutral-100 dark:bg-neutral-900'
                          : 'hover:bg-neutral-50 dark:hover:bg-neutral-900/60',
                      )}
                    >
                      {isDir ? (
                        isOpen ? (
                          <ChevronDown
                            className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400"
                            strokeWidth={1.75}
                          />
                        ) : (
                          <ChevronRight
                            className="h-3.5 w-3.5 text-neutral-500 dark:text-neutral-400"
                            strokeWidth={1.75}
                          />
                        )
                      ) : (
                        <span className="w-3.5" />
                      )}
                      <Icon className={cn('h-3.5 w-3.5 shrink-0', color)} strokeWidth={1.75} />
                      <span
                        className={cn(
                          'truncate',
                          isActive
                            ? 'font-medium text-neutral-900 dark:text-neutral-100'
                            : 'text-neutral-700 dark:text-neutral-300',
                        )}
                      >
                        {node.name}
                      </span>
                    </div>
                  )}
                  {showCreateAfter ? renderInlineInput(inlineEdit.depth) : null}
                </li>
              );
            })}
            {inlineEdit?.kind === 'create' && flat.length === 0
              ? renderInlineInput(inlineEdit.depth)
              : null}
          </ul>
        )}
      </div>

      {contextMenu ? (
        <div
          role="menu"
          aria-label={t('fileTree.context.menuLabel', { defaultValue: 'File context menu' }) as string}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          className={cn(
            'fixed z-50 w-44 rounded-lg border bg-white p-1 shadow-lg',
            'border-neutral-200 dark:border-neutral-700 dark:bg-neutral-900',
          )}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          {contextMenu.node ? (
            <>
              {contextMenu.node.type === 'directory' ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() =>
                      handleNewFile(
                        contextMenu.node!.path,
                        (depthByPath.get(contextMenu.node!.path) ?? 0) + 1,
                      )
                    }
                    className={menuItemClass}
                  >
                    <FilePlus className={menuIconClass} strokeWidth={1.75} />
                    {t('fileTree.context.newFile', { defaultValue: 'New File' })}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() =>
                      handleNewFolder(
                        contextMenu.node!.path,
                        (depthByPath.get(contextMenu.node!.path) ?? 0) + 1,
                      )
                    }
                    className={menuItemClass}
                  >
                    <FolderPlus className={menuIconClass} strokeWidth={1.75} />
                    {t('fileTree.context.newFolder', { defaultValue: 'New Folder' })}
                  </button>
                  <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />
                </>
              ) : (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => handleOpen(contextMenu.node!)}
                    className={menuItemClass}
                  >
                    <FilePlus className={menuIconClass} strokeWidth={1.75} />
                    Open
                  </button>
                  <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />
                </>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  handleRename(
                    contextMenu.node!,
                    depthByPath.get(contextMenu.node!.path) ?? 0,
                  )
                }
                className={menuItemClass}
              >
                <Pencil className={menuIconClass} strokeWidth={1.75} />
                {t('fileTree.context.rename', { defaultValue: 'Rename' })}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => handleCopyPath(contextMenu.node!)}
                className={menuItemClass}
              >
                <ClipboardCopy className={menuIconClass} strokeWidth={1.75} />
                {t('fileTree.context.copyPath', { defaultValue: 'Copy Path' })}
              </button>
              <div className="my-1 border-t border-neutral-100 dark:border-neutral-800" />
              <button
                type="button"
                role="menuitem"
                onClick={() => handleDelete(contextMenu.node!)}
                className={cn(menuItemClass, 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30')}
              >
                <Trash2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
                {t('fileTree.context.delete', { defaultValue: 'Delete' })}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => handleNewFile('', 0)}
                className={menuItemClass}
              >
                <FilePlus className={menuIconClass} strokeWidth={1.75} />
                {t('fileTree.context.newFile', { defaultValue: 'New File' })}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => handleNewFolder('', 0)}
                className={menuItemClass}
              >
                <FolderPlus className={menuIconClass} strokeWidth={1.75} />
                {t('fileTree.context.newFolder', { defaultValue: 'New Folder' })}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
