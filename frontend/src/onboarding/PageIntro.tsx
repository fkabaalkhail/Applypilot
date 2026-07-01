import { useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { PageIntroModal } from "./PageIntroModal";
import {
  PAGE_INTROS,
  pageIntroSeenKey,
  NEW_USER_WINDOW_DAYS,
  type PageIntroId,
} from "./pageIntros";

const DAY_MS = 24 * 60 * 60 * 1000;

/** True for recently-created accounts; established users are never interrupted. */
function isNewUser(createdAt?: string): boolean {
  if (!createdAt) return false;
  const ts = Date.parse(createdAt);
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts < NEW_USER_WINDOW_DAYS * DAY_MS;
}

/**
 * Drop-in first-visit intro for a page: `<PageIntro page="applications" />`.
 * Shows once per page (localStorage) to new users only. Never crashes.
 */
export function PageIntro({ page }: { page: PageIntroId }) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!user || !isNewUser(user.created_at)) return;
    try {
      if (localStorage.getItem(pageIntroSeenKey(page))) return;
    } catch {
      return;
    }
    setOpen(true);
  }, [user, page]);

  const dismiss = () => {
    try {
      localStorage.setItem(pageIntroSeenKey(page), "1");
    } catch {
      /* ignore quota */
    }
    setOpen(false);
  };

  if (!open) return null;
  return <PageIntroModal content={PAGE_INTROS[page]} onClose={dismiss} />;
}
