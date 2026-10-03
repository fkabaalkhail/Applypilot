/**
 * Profiles the e2e harness syncs into the real extension.
 *
 * MOCK mirrors src/api/mockProfile.ts (the extension's own sample data) so the
 * old in-page harness and this one agree on what "John Doe" answers. The others
 * are shaped like REAL profiles in production (2026-10-03 survey of stored
 * answers): sparse structured fields, free-text work authorization, a single
 * location string instead of a structured address.
 */
export const MOCK = {
  firstName: "John",
  lastName: "Doe",
  email: "john@example.com",
  phone: "+1 555 555 5555",
  location: "Ottawa, ON, Canada",
  addressStreet: "123 Example Street",
  addressCity: "",
  addressState: "ON",
  postalCode: "K1A 0A6",
  country: "Canada",
  linkedin: "https://linkedin.com/in/johndoe",
  github: "https://github.com/johndoe",
  portfolio: "https://johndoe.com",
  currentCompany: "Example Company",
  currentTitle: "Software Engineer",
  workAuthorization: "Authorized to work in Canada",
  requiresSponsorship: "No",
  dateOfBirth: "1999-03-14",
  willingToRelocate: "Yes",
  workPreference: "Hybrid",
  noticePeriod: "2 weeks",
  earliestStartDate: "2026-09-01",
  yearsOfExperience: "3",
  securityClearance: "None",
  driversLicense: "Yes",
  languages: "English (Native), French (Professional)",
  education: [{ school: "University of Ottawa", degree: "BSc Computer Science", graduationYear: "2026" }],
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
  eeo: {
    gender: "Male",
    genderIdentity: "Cisgender",
    pronouns: "He/Him",
    race: "White",
    hispanicLatino: "No",
    veteranStatus: "I am not a protected veteran",
    disabilityStatus: "No, I do not have a disability",
    sexualOrientation: "Heterosexual",
  },
};

/**
 * A sparse, realistic profile: what most real users actually have. No
 * structured address (only `location`), no stated years of experience, no
 * stated current title/company, work authorization as a free-text sentence.
 * Every answer the forms want beyond the basics has to be INFERRED.
 */
export const SPARSE_CANADIAN = {
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

/** A US-based applicant on a student visa: the sponsorship answer is YES. */
export const US_F1_STUDENT = {
  firstName: "Arjun",
  lastName: "Mehta",
  email: "arjun.mehta@example.com",
  phone: "+1 (617) 555-0199",
  location: "",
  addressStreet: "77 Massachusetts Ave, Apt 4B",
  addressCity: "Cambridge",
  addressState: "MA",
  postalCode: "02139",
  country: "United States",
  linkedin: "https://linkedin.com/in/arjunmehta",
  github: "https://github.com/arjunm",
  portfolio: "",
  currentCompany: "",
  currentTitle: "",
  workAuthorization: "F-1 student visa (OPT eligible)",
  requiresSponsorship: "Yes",
  dateOfBirth: "2003-06-02",
  education: [{ school: "Massachusetts Institute of Technology", degree: "Master of Science in Computer Science", graduationYear: "2026" }],
  experience: [
    { company: "Acme Robotics", title: "Machine Learning Intern", startDate: "June 2024", endDate: "August 2024", description: "" },
  ],
  skills: ["Python", "PyTorch"],
  coverLetter: "",
};

/** Everything in ONE address string, nothing structured. */
export const ADDRESS_ONLY = {
  ...SPARSE_CANADIAN,
  firstName: "Sam",
  lastName: "Okafor",
  email: "sam.okafor@example.com",
  phone: "604-555-0177",
  location: "",
  addressStreet: "1055 W Georgia St, Vancouver, BC V6E 3P3, Canada",
  workAuthorization: "Permanent resident of Canada",
};
