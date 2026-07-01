import type { TourStep } from "./types";

/**
 * The product tour, as data. Adding/removing a step should only require
 * editing this array. `target` selectors reference `data-tour="..."`
 * attributes on real UI elements — the stable contract with the DOM.
 */
export const TOUR_STEPS: TourStep[] = [
  {
    id: "welcome",
    route: "/app",
    title: "Welcome to Tailrd 👋",
    description:
      "Let's take a quick tour of how Tailrd helps you find, tailor, and track job applications.",
  },
  {
    id: "jobs-list",
    route: "/app",
    target: '[data-tour="jobs-list"]',
    title: "Your job feed",
    description: "Browse and discover roles matched to your profile right here.",
    placement: "right",
  },
  {
    id: "job-filters",
    route: "/app",
    target: '[data-tour="job-filters"]',
    title: "Filter & sort",
    description: "Narrow the feed by fit, location, and work type to focus on the best matches.",
    placement: "bottom",
  },
  {
    id: "open-job",
    route: "/app",
    target: '[data-tour="job-card"]',
    title: "Open a job",
    description: "Click any job to see full details and unlock AI tools for it.",
    placement: "right",
  },
  {
    id: "ai-resume",
    route: "/app",
    target: '[data-tour="ai-tool-resume"]',
    title: "Customize your resume",
    description: "Generate a resume tailored to this exact job in one click.",
    placement: "left",
    prepare: () =>
      (document.querySelector('[data-tour="job-card"]') as HTMLElement | null)?.click(),
  },
  {
    id: "ai-cover-letter",
    route: "/app",
    target: '[data-tour="ai-tool-cover-letter"]',
    title: "Build a cover letter",
    description: "Create a tailored cover letter that matches the role and your background.",
    placement: "left",
    prepare: () =>
      (document.querySelector('[data-tour="job-card"]') as HTMLElement | null)?.click(),
  },
  {
    id: "ai-fit",
    route: "/app",
    target: '[data-tour="ai-tool-fit"]',
    title: "Analyze your fit",
    description: "See how well you match the role and which keywords to add for ATS.",
    placement: "left",
    prepare: () =>
      (document.querySelector('[data-tour="job-card"]') as HTMLElement | null)?.click(),
  },
];
