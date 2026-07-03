/**
 * Builds the non-sensitive applicant profile the backend AI uses as context.
 * Mirrors backend ApplicantProfile (backend/routers/fill.py). EEO/demographic
 * data is deliberately dropped here — it must never reach any server.
 */
import type { UserApplicationProfile } from "../shared/types";

export interface ApplicantProfile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  addressStreet: string;
  addressCity: string;
  addressState: string;
  postalCode: string;
  country: string;
  linkedin: string;
  github: string;
  portfolio: string;
  currentCompany: string;
  currentTitle: string;
  workAuthorization: string;
  requiresSponsorship: string;
  salaryExpectation: string;
  skills: string[];
  experience: string[];
  education: string[];
}

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
  };
}
