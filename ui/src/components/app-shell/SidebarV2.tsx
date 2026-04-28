import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  Folder,
  MessageSquarePlus,
  PanelLeftClose,
  Pencil,
  Plus,
  Settings as SettingsIcon,
  Trash2,
} from 'lucide-react';
import type { TFunction } from 'i18next';
import type { AppTab, Project, ProjectSession, SessionProvider } from '../../types/app';
import { cn } from '../../lib/utils.js';
import {
  projectDisplayName,
  sessionDisplayTitle,
  setProjectCustomName,
  setSessionCustomTitle,
  useCustomNamesVersion,
} from '../../lib/customNames';

const asTimestamp = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

type FlatSession = {
  session: ProjectSession;
  sessionId: string;
  provider: SessionProvider;
  lastActivity: number;
};

const collectSessionsForProject = (project: Project): FlatSession[] => {
  const asSessionList = (sessions: unknown): ProjectSession[] =>
    Array.isArray(sessions) ? sessions : [];

  const all: Array<[SessionProvider, ProjectSession[]]> = [
    ['claude', asSessionList(project.sessions)],
    ['codex', asSessionList(project.codexSessions)],
    ['cursor', asSessionList(project.cursorSessions)],
    ['gemini', asSessionList(project.geminiSessions)],
  ];
  const entries: FlatSession[] = [];
  for (const [provider, sessions] of all) {
    for (const session of sessions) {
      entries.push({
        session,
        sessionId: session.id,
        provider: session.__provider ?? provider,
        lastActivity: Math.max(
          asTimestamp(session.lastActivity),
          asTimestamp(session.updated_at),
          asTimestamp(session.createdAt),
          asTimestamp(session.created_at),
        ),
      });
    }
  }
  return entries.sort((a, b) => b.lastActivity - a.lastActivity);
};

const formatRelative = (ts: number, t: TFunction): string => {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return t('sidebar:time.justNow', { defaultValue: 'just now' });
  if (diff < 3_600_000) {
    const minutes = Math.floor(diff / 60_000);
    if (minutes === 1) return t('sidebar:time.oneMinuteAgo', { defaultValue: '1 min ago' });
    return t('sidebar:time.minutesAgo', { count: minutes, defaultValue: `${minutes} mins ago` });
  }
  if (diff < 86_400_000) {
    const hours = Math.floor(diff / 3_600_000);
    if (hours === 1) return t('sidebar:time.oneHourAgo', { defaultValue: '1 hour ago' });
    return t('sidebar:time.hoursAgo', { count: hours, defaultValue: `${hours} hours ago` });
  }
  const days = Math.floor(diff / 86_400_000);
  if (days === 1) return t('sidebar:time.oneDayAgo', { defaultValue: '1 day ago' });
  return t('sidebar:time.daysAgo', { count: days, defaultValue: `${days} days ago` });
};

export type SidebarV2Props = {
  projects: Project[];
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  isLoading: boolean;
  onSelectTab: (tab: AppTab) => void;
  onSelectProject: (project: Project) => void;
  onSelectSession: (project: Project, sessionId: string) => void;
  onStartNewSession: (project: Project | null) => void;
  onCreateProject: () => void;
  onRequestDeleteProject: (project: Project) => void;
  onRequestDeleteSession: (project: Project, session: ProjectSession, provider: SessionProvider) => void;
  onShowSettings: () => void;
  onCollapse?: () => void;
};

type SidebarContextMenu =
  | {
      kind: 'project';
      project: Project;
      x: number;
      y: number;
    }
  | {
      kind: 'session';
      project: Project;
      session: ProjectSession;
      provider: SessionProvider;
      x: number;
      y: number;
    };

const CONTEXT_MENU_WIDTH = 176;
const CONTEXT_MENU_HEIGHT = 88;
const CONTEXT_MENU_MARGIN = 8;

const contextMenuPosition = (event: MouseEvent) => {
  const maxX = window.innerWidth - CONTEXT_MENU_WIDTH - CONTEXT_MENU_MARGIN;
  const maxY = window.innerHeight - CONTEXT_MENU_HEIGHT - CONTEXT_MENU_MARGIN;
  return {
    x: Math.max(CONTEXT_MENU_MARGIN, Math.min(event.clientX, maxX)),
    y: Math.max(CONTEXT_MENU_MARGIN, Math.min(event.clientY, maxY)),
  };
};

export default function SidebarV2({
  projects,
  selectedProject,
  selectedSession,
  activeTab,
  isLoading,
  onSelectProject,
  onSelectSession,
  onStartNewSession,
  onCreateProject,
  onRequestDeleteProject,
  onRequestDeleteSession,
  onShowSettings,
  onCollapse,
}: SidebarV2Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  useCustomNamesVersion();
  const safeProjects = Array.isArray(projects) ? projects : [];

  const [renamingProject, setRenamingProject] = useState<string | null>(null);
  const [renamingSession, setRenamingSession] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>('');
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [contextMenu, setContextMenu] = useState<SidebarContextMenu | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if ((renamingProject || renamingSession) && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingProject, renamingSession]);

  useEffect(() => {
    if (!contextMenu) return undefined;

    const closeContextMenu = () => setContextMenu(null);
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') closeContextMenu();
    };

    window.addEventListener('click', closeContextMenu);
    window.addEventListener('resize', closeContextMenu);
    window.addEventListener('scroll', closeContextMenu, true);
    window.addEventListener('keydown', closeOnEscape);

    return () => {
      window.removeEventListener('click', closeContextMenu);
      window.removeEventListener('resize', closeContextMenu);
      window.removeEventListener('scroll', closeContextMenu, true);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!selectedProject?.name) return;
    setExpandedGroups((previous) => {
      if (previous.has(selectedProject.name)) return previous;
      const next = new Set(previous);
      next.add(selectedProject.name);
      return next;
    });
  }, [selectedProject?.name]);

  const generalProject =
    safeProjects.find((project) => project.name === 'general' || project.displayName === 'general') ?? null;
  const otherProjects = safeProjects.filter((project) => project !== generalProject);

  const navToProject = useCallback(
    (name: string) => navigate(`/p/${encodeURIComponent(name)}`),
    [navigate],
  );

  const toggleProjectExpanded = useCallback((project: Project) => {
    setExpandedGroups((previous) => {
      const next = new Set(previous);
      if (next.has(project.name)) {
        next.delete(project.name);
      } else {
        next.add(project.name);
      }
      return next;
    });
  }, []);

  const ensureExpanded = useCallback((project: Project) => {
    setExpandedGroups((previous) => {
      if (previous.has(project.name)) return previous;
      const next = new Set(previous);
      next.add(project.name);
      return next;
    });
  }, []);

  const handleProjectClick = useCallback(
    (project: Project) => {
      if (renamingProject === project.name) return;
      onSelectProject(project);
      toggleProjectExpanded(project);
      navToProject(project.name);
    },
    [navToProject, onSelectProject, renamingProject, toggleProjectExpanded],
  );

  const handleSessionClick = useCallback(
    (project: Project, sessionId: string) => {
      if (renamingSession === sessionId) return;
      onSelectSession(project, sessionId);
      ensureExpanded(project);
    },
    [ensureExpanded, onSelectSession, renamingSession],
  );

  const handleNewSession = useCallback(
    (event: MouseEvent, project: Project) => {
      event.stopPropagation();
      ensureExpanded(project);
      onStartNewSession(project);
      navToProject(project.name);
    },
    [ensureExpanded, navToProject, onStartNewSession],
  );

  const openProjectContextMenu = useCallback(
    (event: MouseEvent, project: Project, isGeneral: boolean) => {
      if (isGeneral || renamingProject === project.name) return;
      event.preventDefault();
      event.stopPropagation();
      const position = contextMenuPosition(event);
      setContextMenu({
        kind: 'project',
        project,
        x: position.x,
        y: position.y,
      });
    },
    [renamingProject],
  );

  const openSessionContextMenu = useCallback(
    (event: MouseEvent, project: Project, session: ProjectSession, provider: SessionProvider) => {
      if (renamingSession === session.id) return;
      event.preventDefault();
      event.stopPropagation();
      const position = contextMenuPosition(event);
      setContextMenu({
        kind: 'session',
        project,
        session,
        provider,
        x: position.x,
        y: position.y,
      });
    },
    [renamingSession],
  );

  const beginRenameProject = useCallback((project: Project) => {
    setContextMenu(null);
    setRenamingSession(null);
    setRenamingProject(project.name);
    setRenameDraft(projectDisplayName(project));
  }, []);

  const beginRenameSession = useCallback((session: ProjectSession) => {
    setContextMenu(null);
    setRenamingProject(null);
    setRenamingSession(session.id);
    setRenameDraft(sessionDisplayTitle(session));
  }, []);

  const requestDeleteProject = useCallback(
    (project: Project) => {
      setContextMenu(null);
      onRequestDeleteProject(project);
    },
    [onRequestDeleteProject],
  );

  const requestDeleteSession = useCallback(
    (project: Project, session: ProjectSession, provider: SessionProvider) => {
      setContextMenu(null);
      onRequestDeleteSession(project, session, provider);
    },
    [onRequestDeleteSession],
  );

  const handleContextRename = useCallback(() => {
    if (!contextMenu) return;
    if (contextMenu.kind === 'project') {
      beginRenameProject(contextMenu.project);
    } else {
      beginRenameSession(contextMenu.session);
    }
  }, [beginRenameProject, beginRenameSession, contextMenu]);

  const handleContextDelete = useCallback(() => {
    if (!contextMenu) return;
    if (contextMenu.kind === 'project') {
      requestDeleteProject(contextMenu.project);
    } else {
      requestDeleteSession(contextMenu.project, contextMenu.session, contextMenu.provider);
    }
  }, [contextMenu, requestDeleteProject, requestDeleteSession]);

  const commitProjectRename = useCallback(() => {
    if (!renamingProject) return;
    setProjectCustomName(renamingProject, renameDraft);
    setRenamingProject(null);
    setRenameDraft('');
  }, [renamingProject, renameDraft]);

  const commitSessionRename = useCallback(() => {
    if (!renamingSession) return;
    setSessionCustomTitle(renamingSession, renameDraft);
    setRenamingSession(null);
    setRenameDraft('');
  }, [renamingSession, renameDraft]);

  const cancelRename = useCallback(() => {
    setRenamingProject(null);
    setRenamingSession(null);
    setRenameDraft('');
  }, []);

  const handleRenameKey = useCallback(
    (event: KeyboardEvent<HTMLInputElement>, kind: 'project' | 'session') => {
      if (event.key === 'Enter') {
        event.preventDefault();
        if (kind === 'project') commitProjectRename();
        else commitSessionRename();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRename();
      }
    },
    [cancelRename, commitProjectRename, commitSessionRename],
  );

  const renderSessionRows = (project: Project) => {
    const sessions = collectSessionsForProject(project).slice(0, 30);
    const showDraftSession =
      selectedProject?.name === project.name && activeTab === 'chat' && !selectedSession;

    return (
      <div className="ml-6 space-y-0.5">
        {showDraftSession ? (
          <button
            type="button"
            onClick={(event) => handleNewSession(event, project)}
            className="block w-full rounded-md bg-neutral-200/70 px-2 py-1 text-left text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100"
          >
            <div className="truncate text-[12.5px]">
              {t('sidebar:sessions.newSession', { defaultValue: 'New Session' })}
            </div>
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
              {t('sidebar:sessions.unsaved', { defaultValue: 'Not saved yet' })}
            </div>
          </button>
        ) : null}

        {sessions.length > 0 ? (
          sessions.map(({ session, sessionId, provider, lastActivity }) => {
            const isSessionActive =
              selectedProject?.name === project.name &&
              selectedSession?.id === sessionId &&
              activeTab === 'chat';
            const isSessionRenaming = renamingSession === sessionId;

            return (
              <div
                key={sessionId}
                onContextMenu={(event) => openSessionContextMenu(event, project, session, provider)}
                className={cn(
                  'group/session relative w-full rounded-md transition-colors',
                  isSessionActive
                    ? 'bg-neutral-200/70 dark:bg-neutral-800'
                    : 'hover:bg-neutral-100 dark:hover:bg-neutral-800',
                )}
              >
                {isSessionRenaming ? (
                  <div className="flex items-center px-2 py-1">
                    <input
                      ref={renameInputRef}
                      value={renameDraft}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onBlur={commitSessionRename}
                      onKeyDown={(event) => handleRenameKey(event, 'session')}
                      onClick={(event) => event.stopPropagation()}
                      placeholder={t('sidebar:renamePlaceholder', { defaultValue: 'Rename - empty to reset' }) as string}
                      className="w-full rounded-sm border border-neutral-300 bg-white px-1.5 py-0.5 text-[12.5px] text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
                    />
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => handleSessionClick(project, sessionId)}
                    className="block w-full px-2 py-1 text-left"
                  >
                    <div className="truncate text-[12.5px] text-neutral-900 dark:text-neutral-100">
                      {sessionDisplayTitle(session)}
                    </div>
                    <div className="text-[11px] text-neutral-500 dark:text-neutral-400">
                      {formatRelative(lastActivity, t)}
                    </div>
                  </button>
                )}

              </div>
            );
          })
        ) : (
          <div className="px-2 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
            {t('sidebar:sessions.noSessions', { defaultValue: 'No sessions yet' })}
          </div>
        )}
      </div>
    );
  };

  const renderProjectGroup = (project: Project, options: { isGeneral?: boolean } = {}) => {
    const isGeneral = Boolean(options.isGeneral);
    const isSelected = project.name === selectedProject?.name;
    const isExpanded = expandedGroups.has(project.name);
    const isRenaming = renamingProject === project.name;
    const label = isGeneral
      ? t('sidebar:general.name', { defaultValue: 'General' })
      : projectDisplayName(project);

    return (
      <div key={project.name} className="space-y-0.5">
        <div
          onContextMenu={(event) => openProjectContextMenu(event, project, isGeneral)}
          className={cn(
            'group/project flex h-8 w-full items-center rounded-lg pr-1 text-[13px] transition-colors',
            isSelected
              ? 'bg-neutral-200/70 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
              : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800',
          )}
        >
          {isRenaming && !isGeneral ? (
            <div className="flex h-full min-w-0 flex-1 items-center gap-1.5 pl-2 pr-1">
              <Folder className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
              <input
                ref={renameInputRef}
                value={renameDraft}
                onChange={(event) => setRenameDraft(event.target.value)}
                onBlur={commitProjectRename}
                onKeyDown={(event) => handleRenameKey(event, 'project')}
                onClick={(event) => event.stopPropagation()}
                placeholder={t('sidebar:renamePlaceholder', { defaultValue: 'Rename - empty to reset' }) as string}
                className="w-full rounded-sm border border-neutral-300 bg-white px-1.5 py-0.5 text-[12.5px] text-neutral-900 outline-none focus:border-neutral-500 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => handleProjectClick(project)}
              className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-l-lg pl-1.5 pr-1 text-left"
            >
              <ChevronRight
                className={cn(
                  'h-3.5 w-3.5 shrink-0 text-neutral-500 transition-transform dark:text-neutral-400',
                  isExpanded && 'rotate-90',
                )}
                strokeWidth={1.75}
              />
              <Folder
                className={cn(
                  'h-3.5 w-3.5 shrink-0',
                  isSelected
                    ? 'text-neutral-900 dark:text-neutral-100'
                    : 'text-neutral-500 dark:text-neutral-400',
                )}
                strokeWidth={1.75}
              />
              <span className="flex-1 truncate">{label}</span>
            </button>
          )}

          {!isRenaming ? (
            <div
              className={cn(
                'ml-1 flex shrink-0 items-center gap-0.5 transition-opacity',
                '[@media(hover:none)]:opacity-100',
                isSelected
                  ? 'opacity-100'
                  : 'opacity-0 group-hover/project:opacity-100 focus-within:opacity-100',
              )}
            >
              <button
                type="button"
                onClick={(event) => handleNewSession(event, project)}
                aria-label={t('sidebar:tooltips.newChat', { defaultValue: 'New Chat' }) as string}
                title={t('sidebar:tooltips.newChat', { defaultValue: 'New Chat' }) as string}
                className={cn(
                  'inline-flex h-6 w-6 items-center justify-center rounded-md',
                  'text-neutral-500 hover:bg-neutral-200/70 hover:text-neutral-900',
                  'dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100',
                )}
              >
                <MessageSquarePlus className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </div>
          ) : null}
        </div>

        {isExpanded ? renderSessionRows(project) : null}
      </div>
    );
  };

  return (
    <aside
      className={cn(
        'flex h-full w-[248px] shrink-0 flex-col',
        'bg-neutral-50 text-neutral-900',
        'dark:bg-neutral-900 dark:text-neutral-100',
        'border-r border-neutral-200 dark:border-neutral-800',
      )}
    >
      <div className="flex h-12 items-center justify-between px-4">
        <button
          type="button"
          onClick={() => navigate('/')}
          aria-label="edgeclaw"
          title="edgeclaw"
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-900 text-[14px] font-semibold text-neutral-50 hover:bg-neutral-800 dark:bg-neutral-50 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          E
        </button>
        {onCollapse ? (
          <button
            type="button"
            onClick={onCollapse}
            aria-label={t('sidebar:tooltips.hideSidebar', { defaultValue: 'Hide sidebar' }) as string}
            title={t('sidebar:tooltips.hideSidebar', { defaultValue: 'Hide sidebar' }) as string}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
          >
            <PanelLeftClose className="h-4 w-4" strokeWidth={1.75} />
          </button>
        ) : null}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {isLoading && safeProjects.length === 0 ? (
          <div className="px-2 py-4 text-xs text-neutral-500 dark:text-neutral-400">
            {t('sidebar:sessions.loading', { defaultValue: 'Loading...' })}
          </div>
        ) : (
          <>
            <section className="pt-3">
              <div className="flex items-center px-3 pb-1">
                <span className="flex-1 text-[11px] font-medium uppercase tracking-[0.04em] text-neutral-500/90 dark:text-neutral-400/80">
                  {t('sidebar:projects.title', { defaultValue: 'Projects' })}
                </span>
                <button
                  type="button"
                  onClick={onCreateProject}
                  aria-label={t('sidebar:projects.newProject', { defaultValue: 'New Project' }) as string}
                  title={t('sidebar:projects.newProject', { defaultValue: 'New Project' }) as string}
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
                >
                  <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              </div>

              {otherProjects.length === 0 ? (
                <div className="px-3 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                  {t('sidebar:projects.noProjects', { defaultValue: 'No projects found' })}
                </div>
              ) : (
                <div className="space-y-0.5">
                  {otherProjects.map((project) => renderProjectGroup(project))}
                </div>
              )}
            </section>

            <section className="pt-4">
              <div className="flex items-center px-3 pb-1">
                <span className="flex-1 text-[11px] font-medium uppercase tracking-[0.04em] text-neutral-500/90 dark:text-neutral-400/80">
                  {t('sidebar:general.title', { defaultValue: 'General' })}
                </span>
              </div>
              {generalProject ? (
                renderProjectGroup(generalProject, { isGeneral: true })
              ) : (
                <div className="px-3 py-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                  {t('sidebar:general.missing', {
                    defaultValue: 'No general workspace found',
                  })}
                </div>
              )}
            </section>
          </>
        )}
      </div>

      <div className="border-t border-neutral-200 px-2 py-2 dark:border-neutral-800">
        <button
          type="button"
          onClick={onShowSettings}
          aria-label={t('sidebar:actions.settings', { defaultValue: 'Settings' }) as string}
          title={t('sidebar:actions.settings', { defaultValue: 'Settings' }) as string}
          className="flex h-9 w-full items-center justify-start gap-2 rounded-lg px-6 text-[13px] font-medium text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
        >
          <SettingsIcon className="h-4 w-4" strokeWidth={1.75} />
          <span>{t('sidebar:actions.settings', { defaultValue: 'Settings' })}</span>
        </button>
      </div>

      {contextMenu ? (
        <div
          role="menu"
          aria-label={t('sidebar:contextMenu.label', { defaultValue: 'Context menu' }) as string}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
          className={cn(
            'fixed z-50 w-44 rounded-lg border border-neutral-200 bg-white p-1 shadow-lg',
            'dark:border-neutral-700 dark:bg-neutral-900',
          )}
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={handleContextRename}
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]',
              'text-neutral-800 hover:bg-neutral-100 dark:text-neutral-100 dark:hover:bg-neutral-800',
            )}
          >
            <Pencil className="h-3.5 w-3.5 shrink-0 text-neutral-500 dark:text-neutral-400" strokeWidth={1.75} />
            <span>{t('sidebar:actions.rename', { defaultValue: 'Rename' })}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={handleContextDelete}
            className={cn(
              'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px]',
              'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40',
            )}
          >
            <Trash2 className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} />
            <span>{t('sidebar:actions.delete', { defaultValue: 'Delete' })}</span>
          </button>
        </div>
      ) : null}
    </aside>
  );
}
