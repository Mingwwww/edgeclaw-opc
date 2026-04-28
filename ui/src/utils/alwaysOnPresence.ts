import { useEffect, useRef } from 'react';
import type { Project } from '../types/app';

type SendMessage = (message: unknown) => void;

function isDocumentVisible(): boolean {
  return typeof document === 'undefined'
    ? true
    : document.visibilityState !== 'hidden';
}

export function useAlwaysOnPresence({
  selectedProject,
  processingSessions,
  sendMessage,
}: {
  selectedProject: Project | null;
  processingSessions: Set<string>;
  sendMessage: SendMessage;
}) {
  const lastUserMsgAtRef = useRef<string | null>(null);
  const lastProcessingSizeRef = useRef(processingSessions.size);

  useEffect(() => {
    if (processingSessions.size > lastProcessingSizeRef.current) {
      lastUserMsgAtRef.current = new Date().toISOString();
    }
    lastProcessingSizeRef.current = processingSessions.size;
  }, [processingSessions]);

  useEffect(() => {
    if (!selectedProject) {
      sendMessage({ type: 'always-on-presence-clear' });
      return;
    }

    const sendPresence = () => {
      sendMessage({
        type: 'always-on-presence',
        projectName: selectedProject.name,
        visible: isDocumentVisible(),
        lastUserMsgAt: lastUserMsgAtRef.current,
        processingSessionIds: [...processingSessions],
      });
    };

    sendPresence();
    const interval = window.setInterval(sendPresence, 30_000);
    window.addEventListener('focus', sendPresence);
    window.addEventListener('blur', sendPresence);
    document.addEventListener('visibilitychange', sendPresence);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', sendPresence);
      window.removeEventListener('blur', sendPresence);
      document.removeEventListener('visibilitychange', sendPresence);
    };
  }, [processingSessions, selectedProject, sendMessage]);
}
