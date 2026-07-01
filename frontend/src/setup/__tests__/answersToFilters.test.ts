import { describe, it, expect } from "vitest";
import { answersToFilters } from "../answersToFilters";
import { emptyAnswers } from "../types";

describe("answersToFilters", () => {
  it("maps an empty answer set to empty filters", () => {
    expect(answersToFilters(emptyAnswers)).toEqual({
      country: "", location: [], work_type: [], role_category: [],
      experience_level: [], date_posted: "",
    });
  });

  it("maps country, city, remote, functions, and experience", () => {
    const r = answersToFilters({
      ...emptyAnswers,
      country: "CA",
      city: "Ottawa",
      open_to_remote: true,
      job_functions: ["Software Engineering", "Data Analysis"],
      experience_level: "intern_new_grad",
    });
    expect(r.country).toBe("CA");
    expect(r.location).toEqual(["Ottawa"]);
    expect(r.work_type).toEqual(["remote"]);
    expect(r.role_category).toEqual(["Software Engineering", "Data Analysis"]);
    expect(r.experience_level).toEqual(["intern_new_grad"]);
  });

  it("omits city from location when blank and remote when false", () => {
    const r = answersToFilters({ ...emptyAnswers, country: "US" });
    expect(r.location).toEqual([]);
    expect(r.work_type).toEqual([]);
  });
});
