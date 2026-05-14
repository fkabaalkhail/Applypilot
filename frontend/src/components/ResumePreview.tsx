/* ===== Interfaces (matching ResumeDetail.tsx) ===== */

interface ExperienceItem {
  company: string;
  title: string;
  location: string;
  start_date: string;
  end_date: string;
  bullets: string[];
}

interface EducationItem {
  school: string;
  degree: string;
  start_date: string;
  end_date: string;
  gpa: string;
  achievements: string[];
  coursework: string[];
}

interface ProjectItem {
  name: string;
  link: string;
  organization: string;
  location: string;
  start_date: string;
  end_date: string;
  bullets: string[];
}

interface ResumeProfile {
  name: string;
  email: string;
  phone: string;
  location: string;
  linkedin_url: string;
  github_url: string;
  other_link: string;
  skills: string[];
  experience: ExperienceItem[];
  education: EducationItem[];
  projects: ProjectItem[];
  technologies: Record<string, string[]>;
}

interface ResumePreviewProps {
  profile: ResumeProfile;
  originalProfile: ResumeProfile;
}

/* ===== Helpers ===== */

function isChanged(current: string, original: string): boolean {
  return current !== original && current.trim() !== "";
}

/* ===== Component ===== */

export default function ResumePreview({ profile, originalProfile }: ResumePreviewProps) {
  return (
    <div className="resume-preview">
      {/* Header */}
      <div className="preview-header">
        <h1 className={isChanged(profile.name, originalProfile.name) ? "preview-changed" : ""}>
          {profile.name || "Your Name"}
        </h1>
        <p className="preview-contact">
          {[profile.location, profile.email, profile.phone].filter(Boolean).join(" | ")}
        </p>
        {(profile.linkedin_url || profile.github_url || profile.other_link) && (
          <p className="preview-contact">
            {[profile.linkedin_url, profile.github_url, profile.other_link]
              .filter(Boolean)
              .join(" | ")}
          </p>
        )}
      </div>

      {/* Education */}
      {profile.education.length > 0 && (
        <div className="preview-section">
          <h2 className="preview-section-title">Education</h2>
          {profile.education.map((edu, i) => {
            const orig = originalProfile.education[i];
            return (
              <div key={i} className="preview-entry">
                <div className="preview-entry-header">
                  <strong className={!orig || edu.school !== orig.school ? "preview-changed" : ""}>
                    {edu.school}
                  </strong>
                  <span>
                    {edu.start_date} - {edu.end_date}
                  </span>
                </div>
                <p className={!orig || edu.degree !== orig.degree ? "preview-changed" : ""}>
                  {edu.degree}
                  {edu.gpa ? ` — GPA: ${edu.gpa}` : ""}
                </p>
              </div>
            );
          })}
        </div>
      )}

      {/* Experience */}
      {profile.experience.length > 0 && (
        <div className="preview-section">
          <h2 className="preview-section-title">Experience</h2>
          {profile.experience.map((exp, i) => {
            const orig = originalProfile.experience[i];
            return (
              <div key={i} className="preview-entry">
                <div className="preview-entry-header">
                  <strong className={!orig || exp.title !== orig.title ? "preview-changed" : ""}>
                    {exp.title}
                  </strong>
                  <span>
                    {exp.start_date} - {exp.end_date || "Present"}
                  </span>
                </div>
                <p className={!orig || exp.company !== orig.company ? "preview-changed" : ""}>
                  {exp.company}
                  {exp.location ? ` | ${exp.location}` : ""}
                </p>
                <ul>
                  {exp.bullets.map((bullet, j) => {
                    const origBullet = orig?.bullets[j];
                    const changed = !origBullet || bullet !== origBullet;
                    return bullet.trim() ? (
                      <li key={j} className={changed ? "preview-changed" : ""}>
                        {bullet}
                      </li>
                    ) : null;
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {/* Skills */}
      {profile.skills.length > 0 && (
        <div className="preview-section">
          <h2 className="preview-section-title">Skills</h2>
          <p>
            {profile.skills.map((skill, i) => {
              const isNew = !originalProfile.skills.includes(skill);
              return (
                <span key={i}>
                  <span className={isNew ? "preview-changed" : ""}>{skill}</span>
                  {i < profile.skills.length - 1 ? ", " : ""}
                </span>
              );
            })}
          </p>
        </div>
      )}

      {/* Projects */}
      {profile.projects.length > 0 && (
        <div className="preview-section">
          <h2 className="preview-section-title">Projects</h2>
          {profile.projects.map((proj, i) => {
            const orig = originalProfile.projects[i];
            return (
              <div key={i} className="preview-entry">
                <div className="preview-entry-header">
                  <strong className={!orig || proj.name !== orig.name ? "preview-changed" : ""}>
                    {proj.name}
                  </strong>
                  {proj.start_date && (
                    <span>
                      {proj.start_date} - {proj.end_date}
                    </span>
                  )}
                </div>
                <ul>
                  {proj.bullets.map((bullet, j) => {
                    const origBullet = orig?.bullets[j];
                    const changed = !origBullet || bullet !== origBullet;
                    return bullet.trim() ? (
                      <li key={j} className={changed ? "preview-changed" : ""}>
                        {bullet}
                      </li>
                    ) : null;
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
