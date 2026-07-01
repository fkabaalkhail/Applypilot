import type { ComponentType } from "react";

export interface SetupAnswers {
  first_name: string;
  last_name: string;
  job_functions: string[];      // values from JOB_FUNCTION_OPTIONS -> role_category
  job_types: string[];          // "full_time"|"part_time"|"contract"|"internship" (captured only)
  country: string;              // "CA" | "US" | ""
  city: string;
  open_to_remote: boolean;
  work_authorization: string[]; // e.g. ["needs_sponsorship"] (captured only)
  experience_level: string;     // one EXPERIENCE_OPTIONS value
  target_titles: string[];      // free-text chips (captured only)
}

export interface StepProps {
  answers: SetupAnswers;
  update: (patch: Partial<SetupAnswers>) => void;
}

export interface SetupStep {
  id: string;
  headline: string;                         // left assistant-panel headline
  Component: ComponentType<StepProps>;
  validate?: (a: SetupAnswers) => string | null; // error string or null
}

export const emptyAnswers: SetupAnswers = {
  first_name: "",
  last_name: "",
  job_functions: [],
  job_types: [],
  country: "",
  city: "",
  open_to_remote: false,
  work_authorization: [],
  experience_level: "",
  target_titles: [],
};
