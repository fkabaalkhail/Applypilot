# Onboarding Product Tour

A configuration-driven, framer-motion-based product tour for first-time users.

## How it works
- `OnboardingProvider` (mounted in `App.tsx`) auto-starts the tour once when
  the authenticated user has `has_completed_onboarding === false`. Completion is
  stored in the database (`users.has_completed_onboarding`) via
  `POST /auth/me/onboarding`; mid-tour progress is kept in `localStorage`
  (`tailrd_tour_progress`) so a refresh resumes at the same step.
- Steps are pure data in `tourConfig.tsx`. The engine (`engine/*`) renders the
  spotlight and tooltip and is the ONLY place that imports framer-motion — swap
  it without touching app code.

## Add or edit a step
Edit `tourConfig.tsx` only:

```ts
{
  id: "unique-id",
  route: "/app/somewhere",              // optional: navigate first
  target: '[data-tour="my-element"]',   // omit for a centered card
  title: "Title",
  description: "One or two sentences.",
  placement: "bottom",                  // top | bottom | left | right | auto
  condition: () => window.innerWidth > 768, // optional: skip when false
  prepare: () => openSomething(),        // optional: run before lookup
}
```

Then add `data-tour="my-element"` to the target element. `data-tour` attributes
are the stable contract — restyling/renaming classes won't break the tour.

## Resilience
- Missing target after ~2s → step is skipped (warns in dev only).
- `prepare` throwing → step is skipped.
- Steps whose `condition` is false are skipped (use for responsive breakpoints).

## Analytics
Pass an `analytics` prop to `OnboardingProvider` implementing any of:
`onTourStarted`, `onStepViewed`, `onStepCompleted`, `onTourSkipped`,
`onTourFinished`. Defaults are no-ops.

## Restart
`useOnboarding().restart()` resets the DB flag + localStorage and starts from
step 1. Wired to the "Restart product tour" button in Settings.

## Keyboard
`Esc` = skip · `→` = next · `←` = previous. Tooltip is a focus-trapped
`role="dialog"`; honors `prefers-reduced-motion`.
