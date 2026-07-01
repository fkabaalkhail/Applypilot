/**
 * Configuration for first-visit "page intro" modals shown to new users when
 * they open a non-dashboard page for the first time. Adding a page here + a
 * <PageIntro page="..."/> on that page is all that's needed.
 */
export type PageIntroId = "applications" | "resume" | "interview";

export interface PageIntroContent {
  /** Short eyebrow shown above the title. */
  eyebrow: string;
  title: string;
  description: string;
}

export const PAGE_INTROS: Record<PageIntroId, PageIntroContent> = {
  applications: {
    eyebrow: "Applications",
    title: "Every application, tracked automatically",
    description:
      "When you apply, Tailrd logs it here with its status, company, and date — so you always know where you stand and never lose track of a follow-up.",
  },
  resume: {
    eyebrow: "Resume",
    title: "Tailor your resume for every role",
    description:
      "Store your base resume and let Tailrd generate a version tuned to each job in seconds — matching the keywords that get you past the ATS.",
  },
  interview: {
    eyebrow: "Interview prep",
    title: "Walk in ready with AI interview prep",
    description:
      "Practice with questions generated for the exact roles you're chasing, and sharpen your answers before the real conversation.",
  },
};

/** localStorage key marking a page's intro as already seen. */
export const pageIntroSeenKey = (id: PageIntroId): string => `tailrd_page_intro_${id}`;

/** New users (recent signups) see the intros; established users are not interrupted. */
export const NEW_USER_WINDOW_DAYS = 30;
