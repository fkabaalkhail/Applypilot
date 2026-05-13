import { useState, useRef, useEffect, useCallback } from "react";

export interface JobFilters {
  country: string;           // "US" | "CA" | ""
  location: string[];        // array of city search tags
  work_type: string[];       // ["remote", "hybrid", "onsite"]
  role_category: string[];   // selected categories
  experience_level: string[];  // ["intern_new_grad", "entry", "mid", "senior", "lead", "director"]
  date_posted: string;       // "24h" | "3d" | "week" | "month" | ""
}

interface JobFilterBarProps {
  filters: JobFilters;
  onChange: (filters: JobFilters) => void;
  totalCount?: number;
}

// --- Constants ---

const COUNTRY_OPTIONS = [
  { value: "US", label: "United States" },
  { value: "CA", label: "Canada" },
];

const JOB_FUNCTION_OPTIONS = [
  "Software Engineering",
  "Data Analysis",
  "Machine Learning/AI",
  "Product Management",
  "Marketing",
  "Design",
  "DevOps",
  "Cybersecurity",
  "Business Analyst",
  "Accounting/Finance",
  "Sales",
  "HR",
  "Legal",
  "Operations",
  "Customer Support",
  "Hardware Engineering",
];

const EXPERIENCE_OPTIONS = [
  { value: "intern_new_grad", label: "Intern/New Grad" },
  { value: "entry", label: "Entry Level" },
  { value: "mid", label: "Mid Level" },
  { value: "senior", label: "Senior" },
  { value: "lead", label: "Lead/Staff" },
  { value: "director", label: "Director/Executive" },
];

const WORK_MODEL_OPTIONS = [
  { value: "onsite", label: "Onsite" },
  { value: "hybrid", label: "Hybrid" },
  { value: "remote", label: "Remote" },
];

const DATE_POSTED_OPTIONS = [
  { value: "24h", label: "Past 24 hours" },
  { value: "3d", label: "Past 3 days" },
  { value: "week", label: "Past week" },
  { value: "month", label: "Past month" },
  { value: "", label: "Any time" },
];

// --- Styles ---

const styles = {
  container: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "12px 0",
    flexWrap: "wrap" as const,
    position: "relative" as const,
  },
  pillButton: {
    display: "inline-flex",
    alignItems: "center",
    gap: "6px",
    padding: "8px 14px",
    borderRadius: "999px",
    border: "1px solid #D3D3FF",
    background: "#fff",
    color: "#374151",
    fontSize: "13px",
    fontWeight: 500,
    cursor: "pointer",
    transition: "all 0.15s ease",
    whiteSpace: "nowrap" as const,
    userSelect: "none" as const,
  },
  pillButtonActive: {
    background: "#F0EEFF",
    borderColor: "#7C6CFF",
    color: "#7C6CFF",
  },
  allFiltersButton: {
    background: "#7C6CFF",
    borderColor: "#7C6CFF",
    color: "#fff",
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#7C6CFF",
    color: "#fff",
    fontSize: "11px",
    fontWeight: 600,
    borderRadius: "999px",
    padding: "1px 6px",
    marginLeft: "2px",
    minWidth: "18px",
    height: "18px",
  },
  dropdown: {
    position: "absolute" as const,
    top: "100%",
    left: 0,
    marginTop: "6px",
    background: "#fff",
    borderRadius: "12px",
    border: "1px solid #e5e7eb",
    boxShadow: "0 8px 32px rgba(0,0,0,0.10), 0 2px 8px rgba(0,0,0,0.04)",
    padding: "16px",
    zIndex: 1000,
    minWidth: "260px",
    maxHeight: "400px",
    overflowY: "auto" as const,
  },
  dropdownTitle: {
    fontSize: "13px",
    fontWeight: 600,
    color: "#374151",
    marginBottom: "12px",
  },
  checkboxRow: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "7px 8px",
    borderRadius: "8px",
    cursor: "pointer",
    fontSize: "13px",
    color: "#374151",
    transition: "background 0.1s",
  },
  checkboxRowHover: {
    background: "#F0EEFF",
  },
  checkbox: {
    width: "16px",
    height: "16px",
    accentColor: "#7C6CFF",
    cursor: "pointer",
  },
  radioInput: {
    width: "16px",
    height: "16px",
    accentColor: "#7C6CFF",
    cursor: "pointer",
  },
  footerRow: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: "12px",
    paddingTop: "12px",
    borderTop: "1px solid #f3f4f6",
  },
  resetBtn: {
    background: "none",
    border: "none",
    color: "#6b7280",
    fontSize: "12px",
    cursor: "pointer",
    padding: "4px 8px",
    borderRadius: "6px",
  },
  confirmBtn: {
    background: "#7C6CFF",
    border: "none",
    color: "#fff",
    fontSize: "12px",
    fontWeight: 600,
    cursor: "pointer",
    padding: "6px 16px",
    borderRadius: "8px",
  },
  searchInput: {
    width: "100%",
    padding: "8px 12px",
    borderRadius: "8px",
    border: "1px solid #D3D3FF",
    fontSize: "13px",
    outline: "none",
    marginTop: "8px",
  },
  sectionLabel: {
    fontSize: "11px",
    fontWeight: 600,
    color: "#9ca3af",
    textTransform: "uppercase" as const,
    letterSpacing: "0.5px",
    marginTop: "12px",
    marginBottom: "6px",
  },
  chevron: {
    fontSize: "10px",
    marginLeft: "2px",
    opacity: 0.7,
  },
};

// --- Component ---

export default function JobFilterBar({ filters, onChange, totalCount }: JobFilterBarProps) {
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Temp state for pending selections (before Confirm)
  const [tempCountry, setTempCountry] = useState(filters.country);
  const [tempLocationTags, setTempLocationTags] = useState<string[]>(filters.location);
  const [locationInput, setLocationInput] = useState("");
  const [tempRoleCategory, setTempRoleCategory] = useState<string[]>(filters.role_category);
  const [tempExperience, setTempExperience] = useState<string[]>(Array.isArray(filters.experience_level) ? filters.experience_level : filters.experience_level ? [filters.experience_level] : []);
  const [tempWorkType, setTempWorkType] = useState<string[]>(filters.work_type);
  const [tempDatePosted, setTempDatePosted] = useState(filters.date_posted);

  // Sync temp state when filters change externally
  useEffect(() => {
    setTempCountry(filters.country);
    setTempLocationTags(filters.location);
    setTempRoleCategory(filters.role_category);
    setTempExperience(Array.isArray(filters.experience_level) ? filters.experience_level : filters.experience_level ? [filters.experience_level] : []);
    setTempWorkType(filters.work_type);
    setTempDatePosted(filters.date_posted);
  }, [filters]);

  // --- City tag management ---

  function addCityTag(city: string) {
    const trimmed = city.trim();
    if (!trimmed) return;
    if (tempLocationTags.includes(trimmed)) return;
    setTempLocationTags((prev) => [...prev, trimmed]);
    setLocationInput("");
  }

  function removeCityTag(city: string) {
    setTempLocationTags((prev) => prev.filter((tag) => tag !== city));
  }

  function handleLocationKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      addCityTag(locationInput);
    } else if (e.key === "Backspace" && locationInput === "" && tempLocationTags.length > 0) {
      setTempLocationTags((prev) => prev.slice(0, -1));
    }
  }

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const toggleDropdown = useCallback((name: string) => {
    setOpenDropdown((prev) => (prev === name ? null : name));
  }, []);

  // --- Confirm handlers ---

  function confirmCountry() {
    onChange({ ...filters, country: tempCountry, location: tempLocationTags });
    setOpenDropdown(null);
  }

  function confirmJobFunction() {
    onChange({ ...filters, role_category: tempRoleCategory });
    setOpenDropdown(null);
  }

  function confirmExperience() {
    onChange({ ...filters, experience_level: tempExperience });
    setOpenDropdown(null);
  }

  function confirmWorkModel() {
    onChange({ ...filters, work_type: tempWorkType });
    setOpenDropdown(null);
  }

  function confirmDatePosted() {
    onChange({ ...filters, date_posted: tempDatePosted });
    setOpenDropdown(null);
  }

  // --- Reset handlers ---

  function resetCountry() {
    setTempCountry("");
    setTempLocationTags([]);
    setLocationInput("");
  }

  function resetJobFunction() {
    setTempRoleCategory([]);
  }

  function resetExperience() {
    setTempExperience([]);
  }

  function resetWorkModel() {
    setTempWorkType([]);
  }

  function resetDatePosted() {
    setTempDatePosted("");
  }

  // --- Badge counts ---

  const countryActive = filters.country || filters.location.length > 0;
  const jobFunctionCount = filters.role_category.length;
  const experienceActive = filters.experience_level.length;
  const workModelCount = filters.work_type.length;
  const datePostedActive = filters.date_posted ? 1 : 0;

  return (
    <div ref={containerRef} style={styles.container} role="toolbar" aria-label="Job filters">
      {/* Country Filter */}
      <div style={{ position: "relative", display: "inline-block" }}>
        <FilterPill
          label="Country"
          isActive={!!countryActive}
          count={countryActive ? 1 : 0}
          isOpen={openDropdown === "country"}
          onClick={() => toggleDropdown("country")}
        />
        {openDropdown === "country" && (
          <DropdownPanel style={{}}>
            <div style={styles.dropdownTitle}>Country</div>
            {COUNTRY_OPTIONS.map((opt) => (
              <label key={opt.value} style={styles.checkboxRow}>
                <input
                  type="radio"
                  name="country"
                  style={styles.radioInput}
                  checked={tempCountry === opt.value}
                  onChange={() => setTempCountry(opt.value)}
                />
                {opt.label}
              </label>
            ))}
            <div style={styles.sectionLabel}>Location</div>
            <label style={styles.checkboxRow}>
              <input
                type="checkbox"
                style={styles.checkbox}
                checked={tempLocationTags.length === 0}
                onChange={() => { setTempLocationTags([]); setLocationInput(""); }}
              />
              All locations within {tempCountry === "CA" ? "Canada" : "United States"}
            </label>
            <div style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "6px",
              padding: "8px 12px",
              borderRadius: "8px",
              border: "1px solid #D3D3FF",
              marginTop: "8px",
              minHeight: "38px",
            }}>
              {tempLocationTags.map((tag) => (
                <span
                  key={tag}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "4px 10px",
                    borderRadius: "999px",
                    background: "#F0EEFF",
                    border: "1px solid #D3D3FF",
                    color: "#374151",
                    fontSize: "12px",
                    fontWeight: 500,
                    whiteSpace: "nowrap",
                  }}
                >
                  {tag}
                  <button
                    type="button"
                    tabIndex={0}
                    role="button"
                    onClick={() => removeCityTag(tag)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        removeCityTag(tag);
                      }
                    }}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "none",
                      border: "none",
                      color: "#7C6CFF",
                      fontSize: "14px",
                      fontWeight: 700,
                      cursor: "pointer",
                      padding: "0 2px",
                      lineHeight: 1,
                    }}
                    aria-label={`Remove ${tag} filter`}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                type="text"
                placeholder={tempLocationTags.length === 0 ? "Enter City" : "Add another city"}
                value={locationInput}
                onChange={(e) => setLocationInput(e.target.value)}
                onKeyDown={handleLocationKeyDown}
                aria-label="Type a city name and press Enter to add"
                style={{
                  flex: 1,
                  minWidth: "80px",
                  border: "none",
                  outline: "none",
                  fontSize: "13px",
                  padding: "2px 0",
                }}
              />
            </div>
            <DropdownFooter onReset={resetCountry} onConfirm={confirmCountry} />
          </DropdownPanel>
        )}
      </div>

      {/* Job Function Filter */}
      <div style={{ position: "relative", display: "inline-block" }}>
        <FilterPill
          label="Job Function"
          isActive={jobFunctionCount > 0}
          count={jobFunctionCount}
          isOpen={openDropdown === "jobFunction"}
          onClick={() => toggleDropdown("jobFunction")}
        />
        {openDropdown === "jobFunction" && (
          <DropdownPanel style={{ minWidth: "280px" }}>
            <div style={styles.dropdownTitle}>Job Function</div>
            <div style={{ maxHeight: "280px", overflowY: "auto" }}>
              {JOB_FUNCTION_OPTIONS.map((cat) => (
                <label key={cat} style={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    style={styles.checkbox}
                    checked={tempRoleCategory.includes(cat)}
                    onChange={() => {
                      setTempRoleCategory((prev) =>
                        prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
                      );
                    }}
                  />
                  {cat}
                </label>
              ))}
            </div>
            <DropdownFooter onReset={resetJobFunction} onConfirm={confirmJobFunction} />
          </DropdownPanel>
        )}
      </div>

      {/* Experience Level Filter */}
      <div style={{ position: "relative", display: "inline-block" }}>
        <FilterPill
          label="Experience Level"
          isActive={experienceActive > 0}
          count={experienceActive}
          isOpen={openDropdown === "experience"}
          onClick={() => toggleDropdown("experience")}
        />
        {openDropdown === "experience" && (
          <DropdownPanel style={{}}>
            <div style={styles.dropdownTitle}>Experience Level</div>
            {EXPERIENCE_OPTIONS.map((opt) => (
              <label key={opt.value} style={styles.checkboxRow}>
                <input
                  type="checkbox"
                  style={styles.checkbox}
                  checked={tempExperience.includes(opt.value)}
                  onChange={() => {
                    setTempExperience((prev) =>
                      prev.includes(opt.value) ? prev.filter((v) => v !== opt.value) : [...prev, opt.value]
                    );
                  }}
                />
                {opt.label}
              </label>
            ))}
            <DropdownFooter onReset={resetExperience} onConfirm={confirmExperience} />
          </DropdownPanel>
        )}
      </div>

      {/* Work Model Filter */}
      <div style={{ position: "relative", display: "inline-block" }}>
        <FilterPill
          label="Work Model"
          isActive={workModelCount > 0}
          count={workModelCount}
          isOpen={openDropdown === "workModel"}
          onClick={() => toggleDropdown("workModel")}
        />
        {openDropdown === "workModel" && (
          <DropdownPanel style={{}}>
            <div style={styles.dropdownTitle}>Work Model</div>
            {WORK_MODEL_OPTIONS.map((opt) => (
              <label key={opt.value} style={styles.checkboxRow}>
                <input
                  type="checkbox"
                  style={styles.checkbox}
                  checked={tempWorkType.includes(opt.value)}
                  onChange={() => {
                    setTempWorkType((prev) =>
                      prev.includes(opt.value) ? prev.filter((v) => v !== opt.value) : [...prev, opt.value]
                    );
                  }}
                />
                {opt.label}
              </label>
            ))}
            <DropdownFooter onReset={resetWorkModel} onConfirm={confirmWorkModel} />
          </DropdownPanel>
        )}
      </div>

      {/* Date Posted Filter */}
      <div style={{ position: "relative", display: "inline-block" }}>
        <FilterPill
          label="Date Posted"
          isActive={datePostedActive > 0}
          count={datePostedActive}
          isOpen={openDropdown === "datePosted"}
          onClick={() => toggleDropdown("datePosted")}
        />
        {openDropdown === "datePosted" && (
          <DropdownPanel style={{}}>
            <div style={styles.dropdownTitle}>Date Posted</div>
            {DATE_POSTED_OPTIONS.map((opt) => (
              <label key={opt.value} style={styles.checkboxRow}>
                <input
                  type="radio"
                  name="datePosted"
                  style={styles.radioInput}
                  checked={tempDatePosted === opt.value}
                  onChange={() => setTempDatePosted(opt.value)}
                />
                {opt.label}
              </label>
            ))}
            <DropdownFooter onReset={resetDatePosted} onConfirm={confirmDatePosted} />
          </DropdownPanel>
        )}
      </div>

      {/* All Filters Button */}
      <div style={{ position: "relative", display: "inline-block" }}>
        <button
          style={{ ...styles.pillButton, ...styles.allFiltersButton }}
          onClick={() => toggleDropdown("allFilters")}
          aria-label="All Filters"
        >
          ••• All Filters
        </button>
        {openDropdown === "allFilters" && (
          <DropdownPanel style={{ minWidth: "340px", maxHeight: "500px" }}>
            <div style={styles.dropdownTitle}>All Filters</div>

            <div style={styles.sectionLabel}>Country</div>
            {COUNTRY_OPTIONS.map((opt) => (
              <label key={opt.value} style={styles.checkboxRow}>
                <input
                  type="radio"
                  name="allCountry"
                  style={styles.radioInput}
                  checked={tempCountry === opt.value}
                  onChange={() => setTempCountry(opt.value)}
                />
                {opt.label}
              </label>
            ))}

            <div style={styles.sectionLabel}>Work Model</div>
            {WORK_MODEL_OPTIONS.map((opt) => (
              <label key={opt.value} style={styles.checkboxRow}>
                <input
                  type="checkbox"
                  style={styles.checkbox}
                  checked={tempWorkType.includes(opt.value)}
                  onChange={() => {
                    setTempWorkType((prev) =>
                      prev.includes(opt.value) ? prev.filter((v) => v !== opt.value) : [...prev, opt.value]
                    );
                  }}
                />
                {opt.label}
              </label>
            ))}

            <div style={styles.sectionLabel}>Experience Level</div>
            {EXPERIENCE_OPTIONS.map((opt) => (
              <label key={opt.value} style={styles.checkboxRow}>
                <input
                  type="checkbox"
                  style={styles.checkbox}
                  checked={tempExperience.includes(opt.value)}
                  onChange={() => {
                    setTempExperience((prev) =>
                      prev.includes(opt.value) ? prev.filter((v) => v !== opt.value) : [...prev, opt.value]
                    );
                  }}
                />
                {opt.label}
              </label>
            ))}

            <div style={styles.sectionLabel}>Date Posted</div>
            {DATE_POSTED_OPTIONS.map((opt) => (
              <label key={opt.value} style={styles.checkboxRow}>
                <input
                  type="radio"
                  name="allDatePosted"
                  style={styles.radioInput}
                  checked={tempDatePosted === opt.value}
                  onChange={() => setTempDatePosted(opt.value)}
                />
                {opt.label}
              </label>
            ))}

            <DropdownFooter
              onReset={() => {
                resetCountry();
                resetJobFunction();
                resetExperience();
                resetWorkModel();
                resetDatePosted();
              }}
              onConfirm={() => {
                onChange({
                  ...filters,
                  country: tempCountry,
                  location: tempLocationTags,
                  work_type: tempWorkType,
                  role_category: tempRoleCategory,
                  experience_level: tempExperience,
                  date_posted: tempDatePosted,
                });
                setOpenDropdown(null);
              }}
            />
          </DropdownPanel>
        )}
      </div>

      {/* Total Count */}
      {totalCount !== undefined && (
        <span style={{ marginLeft: "auto", fontSize: "13px", color: "#6b7280", fontWeight: 500 }}>
          {totalCount.toLocaleString()} jobs
        </span>
      )}
    </div>
  );
}

// --- Sub-components ---

function FilterPill({
  label,
  isActive,
  count,
  isOpen,
  onClick,
}: {
  label: string;
  isActive: boolean;
  count: number;
  isOpen: boolean;
  onClick: () => void;
}) {
  const pillStyle = {
    ...styles.pillButton,
    ...(isActive ? styles.pillButtonActive : {}),
    ...(isOpen ? { borderColor: "#7C6CFF", boxShadow: "0 0 0 2px rgba(124,108,255,0.15)" } : {}),
  };

  return (
    <button style={pillStyle} onClick={onClick} aria-expanded={isOpen} aria-haspopup="true">
      {label}
      {count > 0 && <span style={styles.badge}>+{count}</span>}
      <span style={styles.chevron}>{isOpen ? "▲" : "▼"}</span>
    </button>
  );
}

function DropdownPanel({
  children,
  style: extraStyle,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ ...styles.dropdown, ...extraStyle }} role="dialog" aria-modal="false">
      {children}
    </div>
  );
}

function DropdownFooter({ onReset, onConfirm }: { onReset: () => void; onConfirm: () => void }) {
  return (
    <div style={styles.footerRow}>
      <button style={styles.resetBtn} onClick={onReset}>
        Reset
      </button>
      <button style={styles.confirmBtn} onClick={onConfirm}>
        Confirm
      </button>
    </div>
  );
}
