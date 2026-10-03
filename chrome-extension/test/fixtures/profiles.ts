/**
 * Test profiles shaped like REAL production profiles (2026-10-03 survey of
 * stored answers): one location string instead of a structured address,
 * free-text work authorization, no stated years / current company.
 * Mirrors test/e2e/profiles.mjs so jsdom and the real-browser harness agree.
 */
import type { UserApplicationProfile } from "../../src/shared/types";

export const SPARSE_CANADIAN: UserApplicationProfile = {
  firstName: "Maya",
  lastName: "Tremblay",
  email: "maya.tremblay@example.com",
  phone: "(416) 555-0142",
  location: "Toronto, ON, Canada",
  addressStreet: "",
  addressCity: "",
  addressState: "",
  postalCode: "",
  country: "",
  linkedin: "https://www.linkedin.com/in/maya-tremblay",
  github: "",
  portfolio: "",
  currentCompany: "",
  currentTitle: "",
  workAuthorization: "Canadian citizen",
  requiresSponsorship: "",
  dateOfBirth: "",
  education: [
    { school: "University of Waterloo", degree: "Bachelor of Applied Science in Mechatronics Engineering", graduationYear: "2027" },
  ],
  experience: [
    { company: "Shopify", title: "Software Developer Intern", startDate: "2025-01", endDate: "2025-04", description: "" },
    { company: "Kinaxis", title: "Software Engineer Co-op", startDate: "2025-09", endDate: "Present", description: "" },
  ],
  skills: ["Python", "C++", "ROS"],
  coverLetter: "",
};

/** The date every inference test runs on (graduations and "Present" spans move with the clock). */
export const TEST_TODAY = new Date("2026-10-03T12:00:00Z");
