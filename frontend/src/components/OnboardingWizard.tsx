import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const chrome: any;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface WizardStep {
  id: number;
  type: "modal" | "tooltip";
  target?: string;
  position?: "top" | "bottom" | "left" | "right" | "center";
  heading: string;
  description: string;
  buttonLabel: string;
  showBack: boolean;
}

export interface WizardState {
  currentStep: number;
  isComplete: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const STORAGE_KEY = "tailrd_wizard_step";
export const COMPLETION_FLAG = "onboarding_complete";

export const DEMO_PROFILE = {
  first_name: "Fahad",
  last_name: "Aba-Alkhail",
  email: "fahadabraar@gmail.com",
  phone: "6133168025",
  location: "Ottawa, Ontario, Canada",
  linkedin_url: "https://linkedin.com/in/fahadabraar",
  why_good_fit:
    "I'm a great fit for Tailrd because of my extensive background in full-stack development and AI integration. At the University of Ottawa, I built multiple production applications using React, Python, and cloud services. My experience with job platforms and resume parsing directly aligns with Tailrd's mission to simplify the job application process.",
} as const;

export const WIZARD_STEPS: WizardStep[] = [
  {
    id: -1,
    type: "modal",
    position: "center",
    heading: "Welcome to Tailrd",
    description: "Let us show you how to autofill job applications in seconds.",
    buttonLabel: "Get Started",
    showBack: false,
  },
  {
    id: 0,
    type: "tooltip",
    target: "#autofill-btn",
    position: "bottom",
    heading: "Click Autofill",
    description: "Click <purple>Autofill</purple> to see the extension in action.",
    buttonLabel: "Next",
    showBack: false,
  },
  {
    id: 1,
    type: "tooltip",
    target: "#demo-form-fields",
    position: "right",
    heading: "Application Filled",
    description:
      "Just like that, your application has been automatically filled with information from your <purple>Tailrd profile</purple>.",
    buttonLabel: "Next",
    showBack: true,
  },
  {
    id: 2,
    type: "tooltip",
    target: "#custom-question-textarea",
    position: "top",
    heading: "Custom Questions",
    description:
      "Fill in any custom application questions and Tailrd will <purple>save</purple> your answers. Your saved answers will then be used to autofill any future job applications with the exact same question.",
    buttonLabel: "Next",
    showBack: true,
  },
  {
    id: 3,
    type: "tooltip",
    target: "#generate-resume-btn",
    position: "bottom",
    heading: "Tailor Your Resume",
    description:
      "<purple>Tailor</purple> your resume for every job, directly in Tailrd. Our AI analyzes the job description and optimizes your resume to match the keywords and requirements.",
    buttonLabel: "Next",
    showBack: true,
  },
  {
    id: 4,
    type: "tooltip",
    target: "#extension-popup-area",
    position: "left",
    heading: "AI Generation",
    description:
      "Use <purple>AI</purple> to auto-generate tailored resumes and cover letters. Our AI will analyze the job description you are applying to and generate a tailored resume and cover letter in 1-click.",
    buttonLabel: "Next",
    showBack: true,
  },
  {
    id: 5,
    type: "modal",
    position: "center",
    heading: "Supported Platforms",
    description:
      "Tailrd works with most job boards and ATS systems such as <purple>Workday, Lever, Greenhouse</purple>, and more. For unsupported platforms, you can still click on the extension to access your profile information for reference.",
    buttonLabel: "Next",
    showBack: true,
  },
  {
    id: 6,
    type: "tooltip",
    target: "#autofill-info-section",
    position: "bottom",
    heading: "Copy to Clipboard",
    description:
      "From your profile, click on any text to <purple>copy it directly</purple> to your clipboard. We make it easy to copy and paste information directly into job applications.",
    buttonLabel: "Next",
    showBack: true,
  },
  {
    id: 7,
    type: "tooltip",
    target: "#demo-submit-btn",
    position: "top",
    heading: "You're Ready!",
    description:
      "Click <purple>Submit</purple> to finish this job application. See how Tailrd helps you organize submitted applications.",
    buttonLabel: "Finish Setup",
    showBack: true,
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Set the onboarding_complete flag.
 * Tries chrome.storage.local first, falls back to localStorage.
 */
async function setCompletionFlag(): Promise<void> {
  try {
    if (
      typeof chrome !== "undefined" &&
      chrome.storage &&
      chrome.storage.local
    ) {
      await chrome.storage.local.set({ [COMPLETION_FLAG]: true });
      return;
    }
  } catch {
    // chrome.storage not available, fall through
  }
  try {
    localStorage.setItem(COMPLETION_FLAG, "true");
  } catch {
    // localStorage unavailable (private browsing), silently fail
  }
}

/**
 * Persist the current step to localStorage.
 */
function persistStep(step: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(step));
  } catch {
    // localStorage unavailable, silently fail
  }
}

/**
 * Read the persisted step from localStorage.
 * Returns -1 (welcome) if nothing is stored.
 */
function readPersistedStep(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      const parsed = parseInt(stored, 10);
      if (!isNaN(parsed) && parsed >= -1 && parsed <= 7) {
        return parsed;
      }
    }
  } catch {
    // localStorage unavailable
  }
  return -1;
}

/**
 * Clear wizard persistence from localStorage.
 */
function clearWizardState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // silently fail
  }
}

/**
 * Fill demo form fields with DEMO_PROFILE data using native value setters.
 * Uses the native value setter pattern to work with React controlled inputs.
 * Retries after 500ms if fields are not rendered (max 3 retries).
 */
function triggerDemoAutofill(retryCount = 0): void {
  const MAX_RETRIES = 3;

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value"
  )?.set;
  const nativeTextareaValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    "value"
  )?.set;

  const fieldMap: Array<{ id: string; value: string; isTextarea?: boolean }> = [
    { id: "demo-first-name", value: DEMO_PROFILE.first_name },
    { id: "demo-last-name", value: DEMO_PROFILE.last_name },
    { id: "demo-email", value: DEMO_PROFILE.email },
    { id: "demo-phone", value: DEMO_PROFILE.phone },
    { id: "demo-linkedin", value: DEMO_PROFILE.linkedin_url },
    { id: "custom-question-textarea", value: DEMO_PROFILE.why_good_fit, isTextarea: true },
  ];

  let allFieldsFound = true;

  for (const field of fieldMap) {
    const el = document.getElementById(field.id) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) {
      allFieldsFound = false;
      break;
    }
  }

  if (!allFieldsFound) {
    if (retryCount < MAX_RETRIES) {
      setTimeout(() => triggerDemoAutofill(retryCount + 1), 500);
    }
    return;
  }

  for (const field of fieldMap) {
    const el = document.getElementById(field.id) as HTMLInputElement | HTMLTextAreaElement | null;
    if (!el) continue;

    if (field.isTextarea && nativeTextareaValueSetter) {
      nativeTextareaValueSetter.call(el, field.value);
    } else if (!field.isTextarea && nativeInputValueSetter) {
      nativeInputValueSetter.call(el, field.value);
    }

    // Dispatch events to trigger React's synthetic event system
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

// ─── Sub-Components ──────────────────────────────────────────────────────────

interface CutoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const CUTOUT_PADDING = 8;
const TOOLTIP_GAP = 16;

// ─── Tooltip Position Calculation ────────────────────────────────────────────

interface TooltipPosition {
  top: number;
  left: number;
  arrowDirection: "up" | "down" | "left" | "right" | "none";
}

/**
 * Calculate tooltip position relative to target element.
 * Returns centered position if target not found.
 */
function calculateTooltipPosition(
  targetSelector: string | undefined,
  preferredPosition: string | undefined,
  tooltipWidth: number,
  tooltipHeight: number
): TooltipPosition {
  if (!targetSelector) {
    return {
      top: window.innerHeight / 2 - tooltipHeight / 2,
      left: window.innerWidth / 2 - tooltipWidth / 2,
      arrowDirection: "none",
    };
  }

  const el = document.querySelector(targetSelector);
  if (!el) {
    return {
      top: window.innerHeight / 2 - tooltipHeight / 2,
      left: window.innerWidth / 2 - tooltipWidth / 2,
      arrowDirection: "none",
    };
  }

  const rect = el.getBoundingClientRect();
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;

  let top = 0;
  let left = 0;
  let arrowDirection: TooltipPosition["arrowDirection"] = "none";

  switch (preferredPosition) {
    case "bottom":
      // Tooltip below target, arrow points up
      top = rect.bottom + TOOLTIP_GAP;
      left = centerX - tooltipWidth / 2;
      arrowDirection = "up";
      break;
    case "top":
      // Tooltip above target, arrow points down
      top = rect.top - tooltipHeight - TOOLTIP_GAP;
      left = centerX - tooltipWidth / 2;
      arrowDirection = "down";
      break;
    case "left":
      // Tooltip to the left of target, arrow points right
      top = centerY - tooltipHeight / 2;
      left = rect.left - tooltipWidth - TOOLTIP_GAP;
      arrowDirection = "right";
      break;
    case "right":
      // Tooltip to the right of target, arrow points left
      top = centerY - tooltipHeight / 2;
      left = rect.right + TOOLTIP_GAP;
      arrowDirection = "left";
      break;
    default:
      // Center on screen
      top = window.innerHeight / 2 - tooltipHeight / 2;
      left = window.innerWidth / 2 - tooltipWidth / 2;
      arrowDirection = "none";
      break;
  }

  // Clamp to viewport bounds
  const margin = 12;
  if (left < margin) left = margin;
  if (left + tooltipWidth > window.innerWidth - margin) {
    left = window.innerWidth - margin - tooltipWidth;
  }
  if (top < margin) top = margin;
  if (top + tooltipHeight > window.innerHeight - margin) {
    top = window.innerHeight - margin - tooltipHeight;
  }

  return { top, left, arrowDirection };
}

// ─── WizardTooltip Sub-Component ─────────────────────────────────────────────

interface WizardTooltipProps {
  step: WizardStep;
  currentStepId: number;
  onNext: () => void;
  onBack: () => void;
  onFinish: () => void;
}

function WizardTooltip({
  step,
  currentStepId,
  onNext,
  onBack,
  onFinish,
}: WizardTooltipProps): JSX.Element {
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<TooltipPosition>({
    top: window.innerHeight / 2 - 150,
    left: window.innerWidth / 2 - 200,
    arrowDirection: "none",
  });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isModal = step.type === "modal" || step.position === "center";
  const isFinalStep = currentStepId === 7;
  const stepNumber = currentStepId >= 0 ? currentStepId + 1 : null;

  const recalculatePosition = useCallback(() => {
    if (isModal) {
      // Modal-type steps: center on screen without arrow
      const width = tooltipRef.current?.offsetWidth || 400;
      const height = tooltipRef.current?.offsetHeight || 300;
      setPosition({
        top: window.innerHeight / 2 - height / 2,
        left: window.innerWidth / 2 - width / 2,
        arrowDirection: "none",
      });
      return;
    }

    const width = tooltipRef.current?.offsetWidth || 400;
    const height = tooltipRef.current?.offsetHeight || 300;
    const pos = calculateTooltipPosition(
      step.target,
      step.position,
      width,
      height
    );
    setPosition(pos);
  }, [isModal, step.target, step.position]);

  // Calculate position on mount and when step changes
  useEffect(() => {
    // Use requestAnimationFrame to ensure DOM is painted and we can measure
    const raf = requestAnimationFrame(() => {
      recalculatePosition();
    });
    return () => cancelAnimationFrame(raf);
  }, [recalculatePosition]);

  // Recalculate on window resize (debounced 100ms)
  useEffect(() => {
    const handleResize = () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        recalculatePosition();
      }, 100);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [recalculatePosition]);

  // Render description with purple highlights
  const renderDescription = (desc: string): string => {
    return desc.replace(
      /<purple>(.*?)<\/purple>/g,
      '<span style="color: #7c3aed; font-weight: 600;">$1</span>'
    );
  };

  // Arrow styles based on direction
  const renderArrow = () => {
    if (position.arrowDirection === "none") return null;

    const arrowSize = 8;
    const baseStyle: React.CSSProperties = {
      position: "absolute",
      width: 0,
      height: 0,
    };

    switch (position.arrowDirection) {
      case "up":
        // Arrow points up (tooltip is below target)
        return (
          <div
            className="wizard-tooltip-arrow"
            style={{
              ...baseStyle,
              top: -arrowSize,
              left: "50%",
              transform: "translateX(-50%)",
              borderLeft: `${arrowSize}px solid transparent`,
              borderRight: `${arrowSize}px solid transparent`,
              borderBottom: `${arrowSize}px solid #ffffff`,
            }}
          />
        );
      case "down":
        // Arrow points down (tooltip is above target)
        return (
          <div
            className="wizard-tooltip-arrow"
            style={{
              ...baseStyle,
              bottom: -arrowSize,
              left: "50%",
              transform: "translateX(-50%)",
              borderLeft: `${arrowSize}px solid transparent`,
              borderRight: `${arrowSize}px solid transparent`,
              borderTop: `${arrowSize}px solid #ffffff`,
            }}
          />
        );
      case "left":
        // Arrow points left (tooltip is to the right of target)
        return (
          <div
            className="wizard-tooltip-arrow"
            style={{
              ...baseStyle,
              left: -arrowSize,
              top: "50%",
              transform: "translateY(-50%)",
              borderTop: `${arrowSize}px solid transparent`,
              borderBottom: `${arrowSize}px solid transparent`,
              borderRight: `${arrowSize}px solid #ffffff`,
            }}
          />
        );
      case "right":
        // Arrow points right (tooltip is to the left of target)
        return (
          <div
            className="wizard-tooltip-arrow"
            style={{
              ...baseStyle,
              right: -arrowSize,
              top: "50%",
              transform: "translateY(-50%)",
              borderTop: `${arrowSize}px solid transparent`,
              borderBottom: `${arrowSize}px solid transparent`,
              borderLeft: `${arrowSize}px solid #ffffff`,
            }}
          />
        );
      default:
        return null;
    }
  };

  return (
    <div
      ref={tooltipRef}
      className="wizard-tooltip"
      role="dialog"
      aria-labelledby="wizard-heading"
      aria-describedby="wizard-description"
      style={{
        position: "fixed",
        top: `${position.top}px`,
        left: `${position.left}px`,
        background: "#ffffff",
        borderRadius: "12px",
        boxShadow: "0 4px 24px rgba(0,0,0,0.15)",
        padding: "32px",
        zIndex: 10000,
        maxWidth: "420px",
        width: "90%",
      }}
    >
      {/* Arrow */}
      {renderArrow()}

      {/* Step counter */}
      {stepNumber !== null && (
        <div
          className="wizard-step-counter"
          style={{
            fontSize: "12px",
            color: "#6b7280",
            marginBottom: "8px",
          }}
        >
          {stepNumber}/8
        </div>
      )}

      {/* Heading */}
      <h2
        id="wizard-heading"
        style={{
          fontSize: "20px",
          fontWeight: 700,
          margin: "0 0 12px 0",
          color: "#111827",
        }}
      >
        {step.heading}
      </h2>

      {/* Description */}
      <p
        id="wizard-description"
        style={{
          fontSize: "14px",
          lineHeight: 1.6,
          color: "#4b5563",
          margin: "0 0 24px 0",
        }}
        dangerouslySetInnerHTML={{
          __html: renderDescription(step.description),
        }}
      />

      {/* Navigation */}
      <div
        className="wizard-nav"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: step.showBack ? "space-between" : "flex-end",
        }}
      >
        {step.showBack && (
          <button
            onClick={onBack}
            className="wizard-back-btn"
            style={{
              background: "none",
              border: "none",
              color: "#7c3aed",
              fontSize: "14px",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            Back
          </button>
        )}

        {isFinalStep ? (
          <button
            onClick={onFinish}
            className="wizard-next-btn"
            style={{
              background: "#7c3aed",
              color: "#fff",
              border: "none",
              borderRadius: "8px",
              padding: "10px 24px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {step.buttonLabel}
          </button>
        ) : (
          <button
            onClick={onNext}
            className="wizard-next-btn"
            style={{
              background: "#7c3aed",
              color: "#fff",
              border: "none",
              borderRadius: "8px",
              padding: "10px 24px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {step.buttonLabel}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * WizardOverlay renders a full-viewport semi-transparent overlay with an
 * optional cutout hole around a target element. Uses SVG mask for the cutout.
 * Recalculates position on window resize (debounced 100ms).
 */
function WizardOverlay({ targetSelector }: { targetSelector?: string }): JSX.Element {
  const [cutout, setCutout] = useState<CutoutRect | null>(null);
  const rafRef = useRef<number | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const calculateCutout = useCallback(() => {
    if (!targetSelector) {
      setCutout(null);
      return;
    }
    const el = document.querySelector(targetSelector);
    if (!el) {
      setCutout(null);
      return;
    }
    const rect = el.getBoundingClientRect();
    setCutout({
      x: rect.left - CUTOUT_PADDING,
      y: rect.top - CUTOUT_PADDING,
      width: rect.width + CUTOUT_PADDING * 2,
      height: rect.height + CUTOUT_PADDING * 2,
    });
  }, [targetSelector]);

  useEffect(() => {
    // Initial calculation
    calculateCutout();

    // Debounced resize handler (100ms)
    const handleResize = () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        calculateCutout();
      }, 100);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [calculateCutout]);

  // Recalculate when targetSelector changes
  useEffect(() => {
    calculateCutout();
  }, [targetSelector, calculateCutout]);

  return (
    <div
      className="wizard-overlay"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9999,
        pointerEvents: "none",
      }}
      aria-hidden="true"
    >
      <svg
        width="100%"
        height="100%"
        style={{ position: "absolute", inset: 0 }}
      >
        <defs>
          <mask id="wizard-overlay-mask">
            {/* White = visible (overlay shows), Black = hidden (cutout) */}
            <rect x="0" y="0" width="100%" height="100%" fill="white" />
            {cutout && (
              <rect
                x={cutout.x}
                y={cutout.y}
                width={cutout.width}
                height={cutout.height}
                rx="4"
                ry="4"
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          x="0"
          y="0"
          width="100%"
          height="100%"
          fill="rgba(0, 0, 0, 0.5)"
          mask="url(#wizard-overlay-mask)"
        />
      </svg>
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function OnboardingWizard(): JSX.Element | null {
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState<number>(() => readPersistedStep());
  const [isComplete, setIsComplete] = useState<boolean>(false);
  const [showToast, setShowToast] = useState<boolean>(false);

  // Persist step to localStorage whenever it changes
  useEffect(() => {
    if (!isComplete) {
      persistStep(currentStep);
    }
  }, [currentStep, isComplete]);

  // Trigger demo autofill when wizard advances to step id 0 (step 1/8)
  useEffect(() => {
    if (currentStep === 0) {
      triggerDemoAutofill();
    }
  }, [currentStep]);

  // Get the current step config
  const stepIndex = WIZARD_STEPS.findIndex((s) => s.id === currentStep);
  const step = stepIndex !== -1 ? WIZARD_STEPS[stepIndex] : null;

  const goNext = useCallback(() => {
    if (currentStep < 7) {
      setCurrentStep((prev) => prev + 1);
    }
  }, [currentStep]);

  const goBack = useCallback(() => {
    if (currentStep > -1) {
      setCurrentStep((prev) => prev - 1);
    }
  }, [currentStep]);

  const skipTutorial = useCallback(async () => {
    await setCompletionFlag();
    clearWizardState();
    setIsComplete(true);
    navigate("/app");
  }, [navigate]);

  const finishSetup = useCallback(async () => {
    await setCompletionFlag();
    clearWizardState();
    setIsComplete(true);
    setShowToast(true);
    navigate("/app");
  }, [navigate]);

  // Auto-dismiss toast after 5 seconds
  useEffect(() => {
    if (showToast) {
      const timer = setTimeout(() => setShowToast(false), 5000);
      return () => clearTimeout(timer);
    }
  }, [showToast]);

  // If wizard is complete and no toast, render nothing
  if (isComplete && !showToast) {
    return null;
  }

  // If wizard is complete but toast is showing
  if (isComplete && showToast) {
    return (
      <div
        className="wizard-toast"
        role="status"
        aria-live="polite"
        style={{
          position: "fixed",
          bottom: "24px",
          right: "24px",
          background: "#7c3aed",
          color: "#fff",
          padding: "16px 24px",
          borderRadius: "12px",
          boxShadow: "0 4px 24px rgba(0,0,0,0.15)",
          zIndex: 10001,
          fontSize: "14px",
          maxWidth: "360px",
        }}
      >
        You're all set! Tailrd is ready to autofill your applications.
      </div>
    );
  }

  if (!step) {
    return null;
  }

  return (
    <>
      {/* Skip Tutorial link */}
      <button
        onClick={skipTutorial}
        className="wizard-skip-link"
        style={{
          position: "fixed",
          top: "16px",
          right: "24px",
          zIndex: 10002,
          background: "none",
          border: "none",
          color: "#7c3aed",
          fontSize: "14px",
          cursor: "pointer",
          textDecoration: "underline",
          fontWeight: 500,
        }}
        aria-label="Skip Tutorial"
      >
        Skip Tutorial
      </button>

      {/* Overlay with cutout */}
      <WizardOverlay targetSelector={step.target} />

      {/* Tooltip / Modal card */}
      <WizardTooltip
        step={step}
        currentStepId={currentStep}
        onNext={goNext}
        onBack={goBack}
        onFinish={finishSetup}
      />
    </>
  );
}
