import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BarChart3,
  Bot,
  Database,
  Folder,
  PanelLeftOpen,
  Radio,
  type LucideIcon,
} from 'lucide-react';
import type { AppTab, Project, ProjectSession } from '../../types/app';
import MainContent from '../main-content/view/MainContent';
import type { MainContentProps } from '../main-content/types/types';
import { cn } from '../../lib/utils.js';
import { projectDisplayName, sessionDisplayTitle, useCustomNamesVersion } from '../../lib/customNames';

type Tab = { id: AppTab; labelKey: string; icon: LucideIcon };

// Order matches the primary work modes in the shell. The Agent tab owns both
// the new-session welcome state and existing conversation transcripts.
// Plugin tabs aren't surfaced in this static list.
//
// Shell + Source Control intentionally left out of the visible bar — both
// tools are still reachable via plugin tabs / programmatic activeTab if a
// future feature needs them, but they were noisy in the day-to-day flow.
const TABS: Tab[] = [
  { id: 'chat',      labelKey: 'tabs.chat',      icon: Bot },
  { id: 'files',     labelKey: 'tabs.files',     icon: Folder },
  { id: 'dashboard', labelKey: 'tabs.dashboard', icon: BarChart3 },
  { id: 'memory',    labelKey: 'tabs.memory',    icon: Database },
  { id: 'always-on', labelKey: 'tabs.alwaysOn',  icon: Radio },
];

// V2 main shell: breadcrumb on the left, tool switcher on the right, and the
// active tool's content below. The sidebar stays focused on projects+sessions.
type MainAreaV2Props = MainContentProps & {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  activeTab: AppTab;
  isSidebarCollapsed?: boolean;
  onOpenSidebar?: () => void;
};

export default function MainAreaV2(props: MainAreaV2Props) {
  const { t } = useTranslation();
  const {
    selectedProject,
    selectedSession,
    activeTab,
    setActiveTab,
    isSidebarCollapsed,
    onOpenSidebar,
  } = props;

  useEffect(() => {
    if (activeTab === 'home') {
      setActiveTab('chat');
    }
  }, [activeTab, setActiveTab]);

  // Re-render breadcrumb when the user renames a project/session via the
  // sidebar overlay (subscribes to localStorage + custom event).
  useCustomNamesVersion();

  // Breadcrumb: "ProjectName / Tab" with optional session summary appended in
  // mono. Falls back to "Home" when no project is selected so the breadcrumb
  // never collapses to "/". Project + session strings flow through the
  // customNames overlay so user renames in the sidebar reflect here too.
  const displayActiveTab = activeTab === 'home' ? 'chat' : activeTab;
  const tabLabelKey = TABS.find((tab) => tab.id === displayActiveTab)?.labelKey;
  const tabLabel = tabLabelKey
    ? t(tabLabelKey)
    : displayActiveTab.startsWith('plugin:')
      ? displayActiveTab.replace('plugin:', '')
      : displayActiveTab;
  const sessionSummary = selectedSession ? sessionDisplayTitle(selectedSession) : '';

  return (
    <div className="flex h-full min-w-0 flex-col bg-white text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {/* Header: breadcrumb left, tool switcher right. */}
      <header className="flex h-12 shrink-0 items-center px-6">
        {isSidebarCollapsed ? (
          <div className="mr-4 flex shrink-0 items-center gap-2">
            <span
              title="edgeclaw"
              className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-900 text-[14px] font-semibold text-neutral-50 dark:bg-neutral-50 dark:text-neutral-900"
            >
              E
            </span>
            <button
              type="button"
              onClick={onOpenSidebar}
              aria-label={t('sidebar:tooltips.showSidebar', { defaultValue: 'Show sidebar' }) as string}
              title={t('sidebar:tooltips.showSidebar', { defaultValue: 'Show sidebar' }) as string}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              <PanelLeftOpen className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </div>
        ) : null}
        <div className="flex min-w-0 flex-1 items-center gap-2 text-[13px]">
          <span className="text-neutral-500 dark:text-neutral-400">
            {selectedProject ? projectDisplayName(selectedProject) : t('home', { defaultValue: 'Home' })}
          </span>
          <span className="text-neutral-400/60 dark:text-neutral-500/60">/</span>
          <span className="font-medium">{tabLabel}</span>
          {sessionSummary ? (
            <span className="ml-2 truncate font-mono text-[11px] text-neutral-500 dark:text-neutral-400">
              {sessionSummary}
            </span>
          ) : null}
        </div>

        <div
          role="tablist"
          aria-label="Tools"
          className="scrollbar-thin ml-4 flex h-9 max-w-[70%] shrink-0 items-center gap-1 overflow-x-auto"
        >
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = displayActiveTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[13px] transition-colors',
                  isActive
                    ? 'bg-neutral-100 font-medium text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
                    : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100',
                )}
              >
                <Icon className="h-3.5 w-3.5" strokeWidth={1.75} />
                <span>{t(tab.labelKey)}</span>
              </button>
            );
          })}
        </div>
      </header>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <MainContent {...props} />
      </div>
    </div>
  );
}
