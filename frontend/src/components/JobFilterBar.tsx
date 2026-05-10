import { useState, useRef, useEffect } from "react";

export interface JobFilters {
  country: string;           // "US" | "CA" | ""
  work_type: string[];       // ["remote", "hybrid", "onsite"]
  role_category: string[];   // selected categories
  experience_level: string;  // "new_grad" | "internship" | ""
}

interface JobFilterBarProps {
  filters: JobFilters;
  onChange: (filters: JobFilters) => void;
  totalCount?: number;
}

const COUNTRY_OPTIONS = [
  { value: "", label: "All" },
  { value: "US", label: "USA" },
  { value: "CA", label: "Canada" },
];

const WORK_TYPE_OPTIONS = [
  { value: "remote", label: "Remote" },
  { value: "hybrid", label: "Hybrid" },
  { value: "onsite", label: "On Site" },
];

const EXPERIENCE_OPTIONS = [
  { value: "", label: "All" },
  { value: "new_grad", label: "New Grad" },
  { value: "internship", label: "Internship" },
];

const ROLE_CATEGORIES = [
  "Software Engineering",
  "Data Analysis",
  "Business Analyst",
  "Management and Executive",
  "Engineering and Development",
  "Creatives and Design",
  "Product Management",
  "Sales",
  "Accounting and Finance",
  "Arts and Entertainment",
  "Legal and Compliance",
  "Human Resources",
  "Public Sector and Government",
  "Education and Training",
  "Customer Service and Support",
  "Marketing",
  "Consultant",
];

export default function JobFilterBar({ filters, onChange, totalCount }: JobFilterBarProps) {
  const [showCategories, setShowCategories] = useState(false);
  const categoryRef = useRef<HTMLDivElement>(null);

  // Close category dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (categoryRef.current && !categoryRef.current.contains(e.target as Node)) {
        setShowCategories(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function handleCountryChange(value: string) {
    onChange({ ...filters, country: value });
  }

  function handleWorkTypeToggle(value: string) {
    const current = filters.work_type;
    const updated = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    onChange({ ...filters, work_type: updated });
  }

  function handleExperienceChange(value: string) {
    onChange({ ...filters, experience_level: value });
  }

  function handleCategoryToggle(category: string) {
    const current = filters.role_category;
    const updated = current.includes(category)
      ? current.filter((c) => c !== category)
      : [...current, category];
    onChange({ ...filters, role_category: updated });
  }

  function handleClearCategories() {
    onChange({ ...filters, role_category: [] });
  }

  const selectedCategoryCount = filters.role_category.length;

  return (
    <div className="job-filter-bar" role="toolbar" aria-label="Job filters">
      {/* Country Filter */}
      <div className="filter-group" role="group" aria-label="Country filter">
        <span className="filter-group-label">Country</span>
        <div className="filter-toggles">
          {COUNTRY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`filter-pill ${filters.country === opt.value ? "active" : ""}`}
              onClick={() => handleCountryChange(opt.value)}
              aria-pressed={filters.country === opt.value}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Work Type Filter */}
      <div className="filter-group" role="group" aria-label="Work type filter">
        <span className="filter-group-label">Work Type</span>
        <div className="filter-toggles">
          {WORK_TYPE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`filter-pill ${filters.work_type.includes(opt.value) ? "active" : ""}`}
              onClick={() => handleWorkTypeToggle(opt.value)}
              aria-pressed={filters.work_type.includes(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Role Category Filter */}
      <div className="filter-group filter-group-category" ref={categoryRef} role="group" aria-label="Role category filter">
        <span className="filter-group-label">Category</span>
        <button
          className={`filter-pill category-trigger ${selectedCategoryCount > 0 ? "active" : ""}`}
          onClick={() => setShowCategories(!showCategories)}
          aria-expanded={showCategories}
          aria-haspopup="listbox"
        >
          {selectedCategoryCount > 0
            ? `${selectedCategoryCount} selected`
            : "All Categories"}
          <i className={`fa-solid fa-chevron-${showCategories ? "up" : "down"}`}></i>
        </button>

        {showCategories && (
          <div className="category-dropdown" role="listbox" aria-label="Role categories">
            <div className="category-dropdown-header">
              <span className="category-dropdown-title">Role Categories</span>
              {selectedCategoryCount > 0 && (
                <button
                  className="category-clear-btn"
                  onClick={handleClearCategories}
                  aria-label="Clear all category selections"
                >
                  Clear all
                </button>
              )}
            </div>
            <div className="category-dropdown-list">
              {ROLE_CATEGORIES.map((cat) => (
                <label
                  key={cat}
                  className={`category-option ${filters.role_category.includes(cat) ? "selected" : ""}`}
                  role="option"
                  aria-selected={filters.role_category.includes(cat)}
                >
                  <input
                    type="checkbox"
                    checked={filters.role_category.includes(cat)}
                    onChange={() => handleCategoryToggle(cat)}
                    aria-label={cat}
                  />
                  <span className="category-option-text">{cat}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Experience Level Filter */}
      <div className="filter-group" role="group" aria-label="Experience level filter">
        <span className="filter-group-label">Experience</span>
        <div className="filter-toggles">
          {EXPERIENCE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              className={`filter-pill ${filters.experience_level === opt.value ? "active" : ""}`}
              onClick={() => handleExperienceChange(opt.value)}
              aria-pressed={filters.experience_level === opt.value}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Total Count */}
      {totalCount !== undefined && (
        <div className="filter-count" aria-live="polite">
          <span className="filter-count-number">{totalCount.toLocaleString()}</span>
          <span className="filter-count-label">jobs</span>
        </div>
      )}
    </div>
  );
}
