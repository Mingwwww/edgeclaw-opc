import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { api } from '../utils/api';
import type {
  AppSocketMessage,
  AppTab,
  LoadingProgress,
  Project,
  ProjectSession,
  ProjectsUpdatedMessage,
} from '../types/app';
import { isBackgroundTaskSession } from '../types/app';

type UseProjectsStateArgs = {
  sessionId?: string;
  navigate: NavigateFunction;
  latestMessage: AppSocketMessage | null;
  isMobile: boolean;
  activeSessions: Set<string>;
};

type FetchProjectsOptions = {
  showLoadingState?: boolean;
};

const PROJECT_SESSION_PREVIEW_LIMIT = 5;
const SESSION_PAGE_SIZE = 30;

const serialize = (value: unknown) => JSON.stringify(value ?? null);

const projectsHaveChanges = (
  prevProjects: Project[],
  nextProjects: Project[],
  includeExternalSessions: boolean,
): boolean => {
  if (prevProjects.length !== nextProjects.length) {
    return true;
  }

  return nextProjects.some((nextProject, index) => {
    const prevProject = prevProjects[index];
    if (!prevProject) {
      return true;
    }

    const baseChanged =
      nextProject.name !== prevProject.name ||
      nextProject.displayName !== prevProject.displayName ||
      nextProject.fullPath !== prevProject.fullPath ||
      serialize(nextProject.alwaysOn) !== serialize(prevProject.alwaysOn) ||
      serialize(nextProject.sessionMeta) !== serialize(prevProject.sessionMeta) ||
      serialize(nextProject.sessions) !== serialize(prevProject.sessions) ||
      serialize(nextProject.taskmaster) !== serialize(prevProject.taskmaster);

    if (baseChanged) {
      return true;
    }

    if (!includeExternalSessions) {
      return false;
    }

    return (
      serialize(nextProject.cursorSessions) !== serialize(prevProject.cursorSessions) ||
      serialize(nextProject.codexSessions) !== serialize(prevProject.codexSessions) ||
      serialize(nextProject.geminiSessions) !== serialize(prevProject.geminiSessions)
    );
  });
};

const getProjectSessions = (project: Project): ProjectSession[] => {
  return [
    ...(project.sessions ?? []),
    ...(project.codexSessions ?? []),
    ...(project.cursorSessions ?? []),
    ...(project.geminiSessions ?? []),
  ];
};

const resetProjectSessionPreview = (project: Project): Project => {
  const sessions = project.sessions ?? [];
  if (sessions.length <= PROJECT_SESSION_PREVIEW_LIMIT) {
    return project;
  }

  const total =
    typeof project.sessionMeta?.total === 'number'
      ? project.sessionMeta.total
      : sessions.length;

  return {
    ...project,
    sessions: sessions.slice(0, PROJECT_SESSION_PREVIEW_LIMIT),
    sessionMeta: {
      ...(project.sessionMeta ?? {}),
      total,
      hasMore: total > PROJECT_SESSION_PREVIEW_LIMIT,
    },
  };
};

const isUpdateAdditive = (
  currentProjects: Project[],
  updatedProjects: Project[],
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): boolean => {
  if (!selectedProject || !selectedSession) {
    return true;
  }

  const currentSelectedProject = currentProjects.find((project) => project.name === selectedProject.name);
  const updatedSelectedProject = updatedProjects.find((project) => project.name === selectedProject.name);

  if (!currentSelectedProject || !updatedSelectedProject) {
    return false;
  }

  const currentSelectedSession = getProjectSessions(currentSelectedProject).find(
    (session) => session.id === selectedSession.id,
  );
  const updatedSelectedSession = getProjectSessions(updatedSelectedProject).find(
    (session) => session.id === selectedSession.id,
  );

  if (!currentSelectedSession || !updatedSelectedSession) {
    return false;
  }

  return (
    currentSelectedSession.id === updatedSelectedSession.id &&
    currentSelectedSession.title === updatedSelectedSession.title &&
    currentSelectedSession.created_at === updatedSelectedSession.created_at &&
    currentSelectedSession.updated_at === updatedSelectedSession.updated_at
  );
};

const VALID_TABS: Set<string> = new Set([
  'home',
  'chat',
  'always-on',
  'files',
  'shell',
  'git',
  'tasks',
  'memory',
  'skills',
  'preview',
  'dashboard',
]);

const isValidTab = (tab: string): tab is AppTab => {
  return VALID_TABS.has(tab) || tab.startsWith('plugin:');
};

const readPersistedTab = (): AppTab => {
  try {
    const stored = localStorage.getItem('activeTab');
    if (stored === 'home') {
      return 'chat';
    }
    if (stored && isValidTab(stored)) {
      return stored as AppTab;
    }
  } catch {
    // localStorage unavailable
  }
  return 'chat';
};

export function useProjectsState({
  sessionId,
  navigate,
  latestMessage,
  isMobile,
  activeSessions,
}: UseProjectsStateArgs) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedSession, setSelectedSession] = useState<ProjectSession | null>(null);
  const [activeTab, setActiveTab] = useState<AppTab>(readPersistedTab);

  useEffect(() => {
    try {
      localStorage.setItem('activeTab', activeTab);
    } catch {
      // Silently ignore storage errors
    }
  }, [activeTab]);

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isLoadingProjects, setIsLoadingProjects] = useState(true);
  const [loadingProgress, setLoadingProgress] = useState<LoadingProgress | null>(null);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState('appearance');
  const [externalMessageUpdate, setExternalMessageUpdate] = useState(0);

  const loadingProgressTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track when a session was first selected so the projects_updated handler
  const prevTrackedSessionIdRef = useRef<string | null>(null);
  if (selectedSession?.id !== prevTrackedSessionIdRef.current) {
    prevTrackedSessionIdRef.current = selectedSession?.id ?? null;
  }

  // Mirror `projects` into a ref so async callbacks can read the latest list
  // without closing over stale state (e.g. loadMoreSessions early-bail check).
  const projectsRef = useRef<Project[]>([]);
  useEffect(() => {
    projectsRef.current = projects;
  }, [projects]);

  const fetchProjects = useCallback(async ({ showLoadingState = true }: FetchProjectsOptions = {}) => {
    try {
      if (showLoadingState) {
        setIsLoadingProjects(true);
      }
      const response = await api.projects();
      const projectData = (await response.json()) as Project[];

      if (!Array.isArray(projectData)) {
        console.error('Error fetching projects: expected array, got', projectData);
        return;
      }

      setProjects((prevProjects) => {
        if (prevProjects.length === 0) {
          return projectData;
        }

        return projectsHaveChanges(prevProjects, projectData, true)
          ? projectData
          : prevProjects;
      });
    } catch (error) {
      console.error('Error fetching projects:', error);
    } finally {
      if (showLoadingState) {
        setIsLoadingProjects(false);
      }
    }
  }, []);

  const refreshProjectsSilently = useCallback(async () => {
    // Keep chat view stable while still syncing sidebar/session metadata in background.
    await fetchProjects({ showLoadingState: false });
  }, [fetchProjects]);

  const openSettings = useCallback((tab = 'appearance') => {
    setSettingsInitialTab(tab);
    setShowSettings(true);
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  // Auto-select the project when there is only one, so the user lands on the new session page
  useEffect(() => {
    if (!isLoadingProjects && projects.length === 1 && !selectedProject && !sessionId) {
      setSelectedProject(projects[0]);
    }
  }, [isLoadingProjects, projects, selectedProject, sessionId]);

  useEffect(() => {
    if (!latestMessage) {
      return;
    }

    if (latestMessage.type === 'loading_progress') {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }

      setLoadingProgress(latestMessage as LoadingProgress);

      if (latestMessage.phase === 'complete') {
        loadingProgressTimeoutRef.current = setTimeout(() => {
          setLoadingProgress(null);
          loadingProgressTimeoutRef.current = null;
        }, 500);
      }

      return;
    }

    if (latestMessage.type !== 'projects_updated') {
      return;
    }

    const projectsMessage = latestMessage as ProjectsUpdatedMessage;

    if (projectsMessage.changedFile && selectedSession && selectedProject) {
      const normalized = projectsMessage.changedFile.replace(/\\/g, '/');
      const projectPrefix = `${selectedProject.name}/`;
      const projectRelativeChanged = normalized.startsWith(projectPrefix)
        ? normalized.slice(projectPrefix.length)
        : '';
      const isSelectedBackgroundTranscriptChange =
        selectedSession.__provider === 'claude' &&
        isBackgroundTaskSession(selectedSession) &&
        projectRelativeChanged === selectedSession.relativeTranscriptPath;
      const isMainSessionChange =
        selectedSession.__provider === 'claude' &&
        !isBackgroundTaskSession(selectedSession) &&
        projectRelativeChanged === `${selectedSession.id}.jsonl`;

      if (isMainSessionChange || isSelectedBackgroundTranscriptChange) {
        const isSessionActive = activeSessions.has(selectedSession.id);

        if (!isSessionActive) {
          setExternalMessageUpdate((prev) => prev + 1);
        }
      }
    }

    const hasActiveSession =
      (selectedSession && activeSessions.has(selectedSession.id)) ||
      (activeSessions.size > 0 && Array.from(activeSessions).some((id) => id.startsWith('new-session-')));

    const updatedProjects = projectsMessage.projects;

    if (
      hasActiveSession &&
      !isUpdateAdditive(projects, updatedProjects, selectedProject, selectedSession)
    ) {
      return;
    }

    setProjects(updatedProjects);

    if (!selectedProject) {
      return;
    }

    const updatedSelectedProject = updatedProjects.find(
      (project) => project.name === selectedProject.name,
    );

    if (!updatedSelectedProject) {
      return;
    }

    if (serialize(updatedSelectedProject) !== serialize(selectedProject)) {
      setSelectedProject(updatedSelectedProject);
    }

    if (!selectedSession) {
      return;
    }

    const updatedSelectedSession = getProjectSessions(updatedSelectedProject).find(
      (session) => session.id === selectedSession.id,
    );

    if (!updatedSelectedSession) {
      // The session is absent from the truncated project list (only the
      // top-N sessions are included in projects_updated for performance).
      // This does NOT mean the session was deleted — it may simply be
      // older than the top-N cut-off, or the file watcher hasn't indexed
      // a brand-new session yet.
      //
      // Never clear selectedSession here. The only paths that should
      // clear it are explicit user actions: switching projects, starting
      // a new session, or deleting the session/project.
      return;
    }

    const normalizedUpdatedSelectedSession =
      updatedSelectedSession.__provider || !selectedSession.__provider
        ? updatedSelectedSession
        : { ...updatedSelectedSession, __provider: selectedSession.__provider };

    if (serialize(normalizedUpdatedSelectedSession) !== serialize(selectedSession)) {
      setSelectedSession(normalizedUpdatedSelectedSession);
    }
  }, [latestMessage, selectedProject, selectedSession, activeSessions, projects]);

  useEffect(() => {
    return () => {
      if (loadingProgressTimeoutRef.current) {
        clearTimeout(loadingProgressTimeoutRef.current);
        loadingProgressTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!sessionId || projects.length === 0) {
      return;
    }

    for (const project of projects) {
      const claudeSession = project.sessions?.find((session) => session.id === sessionId);
      if (claudeSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'claude';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...claudeSession, __provider: 'claude' });
        }
        return;
      }

      const cursorSession = project.cursorSessions?.find((session) => session.id === sessionId);
      if (cursorSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'cursor';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...cursorSession, __provider: 'cursor' });
        }
        return;
      }

      const codexSession = project.codexSessions?.find((session) => session.id === sessionId);
      if (codexSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'codex';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...codexSession, __provider: 'codex' });
        }
        return;
      }

      const geminiSession = project.geminiSessions?.find((session) => session.id === sessionId);
      if (geminiSession) {
        const shouldUpdateProject = selectedProject?.name !== project.name;
        const shouldUpdateSession =
          selectedSession?.id !== sessionId || selectedSession.__provider !== 'gemini';

        if (shouldUpdateProject) {
          setSelectedProject(project);
        }
        if (shouldUpdateSession) {
          setSelectedSession({ ...geminiSession, __provider: 'gemini' });
        }
        return;
      }
    }
  }, [sessionId, projects, selectedProject?.name, selectedSession?.id, selectedSession?.__provider]);

  const handleProjectSelect = useCallback(
    (project: Project) => {
      const previewProject = resetProjectSessionPreview(project);
      setSelectedProject(previewProject);
      setSelectedSession(null);
      setProjects((prevProjects) => prevProjects.map(resetProjectSessionPreview));
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );

  const handleSessionSelect = useCallback(
    (session: ProjectSession) => {
      setSelectedSession(session);

      if (activeTab === 'tasks' || activeTab === 'preview') {
        setActiveTab('chat');
      }

      const provider = localStorage.getItem('selected-provider') || 'claude';
      if (provider === 'cursor') {
        sessionStorage.setItem('cursorSessionId', session.id);
      }

      if (isMobile) {
        const sessionProjectName = session.__projectName;
        const currentProjectName = selectedProject?.name;

        if (sessionProjectName !== currentProjectName) {
          setSidebarOpen(false);
        }
      }

      navigate(`/session/${session.id}`);
    },
    [activeTab, isMobile, navigate, selectedProject?.name],
  );

  const handleNewSession = useCallback(
    (project: Project) => {
      setSelectedProject(project);
      setSelectedSession(null);
      setActiveTab('chat');
      navigate('/');

      if (isMobile) {
        setSidebarOpen(false);
      }
    },
    [isMobile, navigate],
  );

	  const handleSessionDelete = useCallback(
	    (sessionIdToDelete: string) => {
	      if (selectedSession?.id === sessionIdToDelete) {
	        setSelectedSession(null);
	        navigate('/');
	      }

	      setProjects((prevProjects) =>
	        prevProjects.map((project) => {
	          const hadSession = [
	            ...(project.sessions ?? []),
	            ...(project.codexSessions ?? []),
	            ...(project.cursorSessions ?? []),
	            ...(project.geminiSessions ?? []),
	          ].some((session) => session.id === sessionIdToDelete);

	          return {
	            ...project,
	            sessions: project.sessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
	            codexSessions: project.codexSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
	            cursorSessions: project.cursorSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
	            geminiSessions: project.geminiSessions?.filter((session) => session.id !== sessionIdToDelete) ?? [],
	            sessionMeta: {
	              ...project.sessionMeta,
	              total: hadSession
	                ? Math.max(0, (project.sessionMeta?.total as number | undefined ?? 0) - 1)
	                : project.sessionMeta?.total,
	            },
	          };
	        }),
	      );
	    },
    [navigate, selectedSession?.id],
  );

  // The /api/projects payload caps each project's sessions array at 5 for a
  // snappy first paint. Sidebar exposes a "Load more" affordance backed by
  // this action: it pages through /api/projects/:name/sessions?limit=&offset=
  // and appends the new claude sessions in place. We track in-flight project
  // names so the button can render a loading state and reject re-entrancy.
  const loadingMoreSessionsRef = useRef<Set<string>>(new Set());
  const [loadingMoreProjectIds, setLoadingMoreProjectIds] = useState<Set<string>>(new Set());

  const setProjectLoading = useCallback((projectName: string, loading: boolean) => {
    if (loading) loadingMoreSessionsRef.current.add(projectName);
    else loadingMoreSessionsRef.current.delete(projectName);
    setLoadingMoreProjectIds(new Set(loadingMoreSessionsRef.current));
  }, []);

  const loadMoreSessions = useCallback(
    async (projectName: string) => {
      if (!projectName) return;
      if (loadingMoreSessionsRef.current.has(projectName)) return;

      const project = projectsRef.current.find((p) => p.name === projectName);
      if (!project) return;
      if (project.sessionMeta?.hasMore === false) return;

      const offset = (project.sessions ?? []).length;
      setProjectLoading(projectName, true);

      try {
        const response = await api.sessions(projectName, SESSION_PAGE_SIZE, offset);
        if (!response.ok) {
          throw new Error(`Failed to load sessions: ${response.status}`);
        }
        const data = (await response.json()) as {
          sessions?: ProjectSession[];
          hasMore?: boolean;
          total?: number;
        };
        const incoming = Array.isArray(data.sessions) ? data.sessions : [];

        const mergeSessions = (existing: ProjectSession[]): ProjectSession[] => {
          const seen = new Set(existing.map((s) => s.id));
          const merged = [...existing];
          for (const session of incoming) {
            if (!session?.id || seen.has(session.id)) continue;
            seen.add(session.id);
            merged.push(session);
          }
          return merged;
        };

        const applyToProject = (target: Project): Project => ({
          ...target,
          sessions: mergeSessions(target.sessions ?? []),
          sessionMeta: {
            ...(target.sessionMeta ?? {}),
            hasMore: Boolean(data.hasMore),
            total: typeof data.total === 'number' ? data.total : target.sessionMeta?.total,
          },
        });

        setProjects((prevProjects) =>
          prevProjects.map((p) => (p.name === projectName ? applyToProject(p) : p)),
        );

        setSelectedProject((prev) =>
          prev && prev.name === projectName ? applyToProject(prev) : prev,
        );
      } catch (error) {
        console.error('loadMoreSessions failed for project', projectName, error);
      } finally {
        setProjectLoading(projectName, false);
      }
    },
    [setProjectLoading],
  );

  const handleSidebarRefresh = useCallback(async () => {
    try {
      const response = await api.projects();
      const freshProjects = (await response.json()) as Project[];

      setProjects((prevProjects) =>
        projectsHaveChanges(prevProjects, freshProjects, true) ? freshProjects : prevProjects,
      );

      if (!selectedProject) {
        return;
      }

      const refreshedProject = freshProjects.find((project) => project.name === selectedProject.name);
      if (!refreshedProject) {
        return;
      }

      if (serialize(refreshedProject) !== serialize(selectedProject)) {
        setSelectedProject(refreshedProject);
      }

      if (!selectedSession) {
        return;
      }

      const refreshedSession = getProjectSessions(refreshedProject).find(
        (session) => session.id === selectedSession.id,
      );

      if (refreshedSession) {
        // Keep provider metadata stable when refreshed payload doesn't include __provider.
        const normalizedRefreshedSession =
          refreshedSession.__provider || !selectedSession.__provider
            ? refreshedSession
            : { ...refreshedSession, __provider: selectedSession.__provider };

        if (serialize(normalizedRefreshedSession) !== serialize(selectedSession)) {
          setSelectedSession(normalizedRefreshedSession);
        }
      }
    } catch (error) {
      console.error('Error refreshing sidebar:', error);
    }
  }, [selectedProject, selectedSession]);

  const handleProjectDelete = useCallback(
    (projectName: string) => {
      if (selectedProject?.name === projectName) {
        setSelectedProject(null);
        setSelectedSession(null);
        navigate('/');
      }

      setProjects((prevProjects) => prevProjects.filter((project) => project.name !== projectName));
    },
    [navigate, selectedProject?.name],
  );

  const handleDeselectProject = useCallback(() => {
    setSelectedProject(null);
    setSelectedSession(null);
    setProjects((prevProjects) => prevProjects.map(resetProjectSessionPreview));
    navigate('/');
  }, [navigate]);

  const handleResetProjectSessionPreview = useCallback((projectName: string) => {
    setProjects((prevProjects) =>
      prevProjects.map((project) =>
        project.name === projectName ? resetProjectSessionPreview(project) : project,
      ),
    );
    setSelectedProject((prev) =>
      prev?.name === projectName ? resetProjectSessionPreview(prev) : prev,
    );
  }, []);

  const sidebarSharedProps = useMemo(
    () => ({
      projects,
      selectedProject,
      selectedSession,
      onProjectSelect: handleProjectSelect,
      onSessionSelect: handleSessionSelect,
      onNewSession: handleNewSession,
      onSessionDelete: handleSessionDelete,
      onProjectDelete: handleProjectDelete,
      isLoading: isLoadingProjects,
      loadingProgress,
      onRefresh: handleSidebarRefresh,
      onShowSettings: () => setShowSettings(true),
      showSettings,
      settingsInitialTab,
      onCloseSettings: () => setShowSettings(false),
      isMobile,
    }),
    [
      handleNewSession,
      handleProjectDelete,
      handleProjectSelect,
      handleSessionDelete,
      handleSessionSelect,
      handleSidebarRefresh,
      isLoadingProjects,
      isMobile,
      loadingProgress,
      projects,
      settingsInitialTab,
      selectedProject,
      selectedSession,
      showSettings,
    ],
  );

  return {
    projects,
    selectedProject,
    selectedSession,
    activeTab,
    sidebarOpen,
    isLoadingProjects,
    loadingProgress,
    isInputFocused,
    showSettings,
    settingsInitialTab,
    externalMessageUpdate,
    setActiveTab,
    setSelectedSession,
    setSidebarOpen,
    setIsInputFocused,
    setShowSettings,
    openSettings,
    fetchProjects,
    refreshProjectsSilently,
    sidebarSharedProps,
    handleProjectSelect,
    handleSessionSelect,
    handleNewSession,
    handleSessionDelete,
    handleProjectDelete,
    handleDeselectProject,
    handleResetProjectSessionPreview,
    setSelectedProject,
    handleSidebarRefresh,
    loadMoreSessions,
    loadingMoreProjectIds,
  };
}
