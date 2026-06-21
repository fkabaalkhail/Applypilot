import type { UserApplicationProfile } from "../shared/types";

/**
 * Mock profile used while the real backend endpoint is not available
 * (or when "Use sample data" is enabled in settings).
 *
 * This is NOT user data — it is clearly fake sample data so the extension
 * can be exercised end-to-end before the API is wired up.
 */
export const MOCK_PROFILE: UserApplicationProfile = {
  firstName: "John",
  lastName: "Doe",
  email: "john@example.com",
  phone: "+1 555 555 5555",
  location: "Ottawa, ON, Canada",
  linkedin: "https://linkedin.com/in/johndoe",
  github: "https://github.com/johndoe",
  portfolio: "https://johndoe.com",
  currentCompany: "Example Company",
  currentTitle: "Software Engineer",
  workAuthorization: "Authorized to work in Canada",
  requiresSponsorship: "No",
  education: [
    {
      school: "University of Ottawa",
      degree: "BSc Computer Science",
      graduationYear: "2026",
    },
  ],
  experience: [
    {
      company: "Example Company",
      title: "Software Engineer Intern",
      startDate: "2025-05",
      endDate: "2025-08",
      description: "Built full-stack features using React, Node.js, and PostgreSQL.",
    },
  ],
  skills: ["JavaScript", "TypeScript", "React", "Node.js", "Python", "PostgreSQL"],
  coverLetter: "Please generate or insert the saved cover letter here.",
};
