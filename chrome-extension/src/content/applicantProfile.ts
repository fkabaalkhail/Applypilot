/**
 * Builds the non-sensitive applicant profile the backend AI uses as context.
 * Mirrors backend ApplicantProfile (backend/routers/fill.py). EEO/demographic
 * data is deliberately dropped here — it must never reach any server.
 */
import type { ApplicantProfile, UserApplicationProfile } from "../shared/types";

export type { ApplicantProfile };

export function toApplicantProfile(p: UserApplicationProfile): ApplicantProfile {
  return {
    firstName: p.firstName ?? "",
    lastName: p.lastName ?? "",
    email: p.email ?? "",
    phone: p.phone ?? "",
    location: p.location ?? "",
    addressStreet: p.addressStreet ?? "",
    addressCity: p.addressCity ?? "",
    addressState: p.addressState ?? "",
    postalCode: p.postalCode ?? "",
    country: p.country ?? "",
    linkedin: p.linkedin ?? "",
    github: p.github ?? "",
    portfolio: p.portfolio ?? "",
    currentCompany: p.currentCompany ?? "",
    currentTitle: p.currentTitle ?? "",
    workAuthorization: p.workAuthorization ?? "",
    requiresSponsorship: p.requiresSponsorship ?? "",
    salaryExpectation: p.salaryExpectation ?? "",
    skills: (p.skills ?? []).slice(0, 30),
    experience: (p.experience ?? [])
      .slice(0, 8)
      .map((e) => {
        const dates = [e.startDate, e.endDate].filter(Boolean).join("–");
        return [`${e.title} at ${e.company}`.trim(), dates ? `(${dates})` : ""].filter(Boolean).join(" ");
      }),
    education: (p.education ?? [])
      .slice(0, 5)
      .map((e) =>
        [`${e.degree}, ${e.school}`.replace(/^, |, $/g, ""), e.graduationYear ? `(${e.graduationYear})` : ""]
          .filter(Boolean)
          .join(" ")
      ),
    // Structured duplicates of the two lists above, for the backend's
    // deterministic resolvers. The prose forms are context for the model and
    // are the wrong input for arithmetic — "BSc, uOttawa (2025)" has to be
    // parsed back apart before a graduation year can be read out of it, and a
    // parser that is wrong about a date is worse than no answer at all.
    dateOfBirth: p.dateOfBirth ?? "",
    workHistory: (p.experience ?? [])
      .slice(0, 8)
      .map((e) => ({ startDate: e.startDate ?? "", endDate: e.endDate ?? "" })),
    educationHistory: (p.education ?? []).slice(0, 5).map((e) => ({
      degree: e.degree ?? "",
      school: e.school ?? "",
      graduationYear: e.graduationYear ?? "",
    })),
  };
}
