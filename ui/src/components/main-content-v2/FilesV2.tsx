import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  Folder,
  FolderOpen,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import type { Project } from '../../types/app';
import { useFileTreeData } from '../file-tree/hooks/useFileTreeData';
import type { FileTreeNode } from '../file-tree/types/types';
import { getFileIconData } from '../file-tree/constants/fileIcons';
import { cn } from '../../lib/utils.js';

type FilesV2Props = {
  selectedProject: Project | null;
  onFileOpen?: (filePath: string) => void;
};

type FlattenedNode = {
  node: FileTreeNode;
  depth: number;
  parentPath: string;
};

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

export default function FilesV2({ selectedProject, onFileOpen }: FilesV2Props) {
  const { t } = useTranslation();
  const { files, loading, refreshFiles } = useFileTreeData(selectedProject);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [activePath, setActivePath] = useState<string | null>(null);

  const flat = useMemo(() => flatten(files, expanded), [files, expanded]);

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

  if (!selectedProject) {
    return (
      <div className="flex h-full items-center justify-center bg-white text-[13px] text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400">
        {t('fileTree.selectProject', { defaultValue: 'Pick a project to browse files.' })}
      </div>
    );
  }

  const cwd = selectedProject.fullPath || selectedProject.path || selectedProject.name;
  const hasExpanded = expanded.size > 0;

  return (
    <div className="flex h-full flex-col bg-white dark:bg-neutral-950">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-neutral-200 px-6 dark:border-neutral-800">
        <span className="truncate font-mono text-xxs text-neutral-500 dark:text-neutral-400">
          {cwd}
        </span>
        <div className="flex items-center gap-1">
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
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-2 text-[13px]">
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
            {flat.map(({ node, depth }) => {
              const isDir = node.type === 'directory';
              const isOpen = isDir && expanded.has(node.path);
              const isActive = activePath === node.path;

              let Icon = Folder;
              let color = 'text-neutral-500 dark:text-neutral-400';
              if (isDir) {
                Icon = isOpen ? FolderOpen : Folder;
              } else {
                const iconData = getFileIconData(node.name);
                Icon = iconData.icon;
                color = iconData.color;
              }

              return (
                <li
                  key={node.path}
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
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
