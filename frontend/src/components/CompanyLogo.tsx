import { useEffect, useMemo, useState } from "react";
import { avatarColor, avatarLetter, logoProviderChain, type JobLike } from "../lib/companyLogo";

interface Props extends JobLike {
  size?: number;
  className?: string;
}

// The favicon service serves whatever resolution the site actually has;
// anything smaller than this would render as an upscaled blur at our display
// sizes (40-52px), so treat it as a miss and fall through.
const MIN_NATURAL_WIDTH = 40;

export default function CompanyLogo({ size = 40, className = "", ...job }: Props) {
  const chain = useMemo(
    () => logoProviderChain(job),
    [job.company, job.company_logo, job.company_domain, job.company_url],
  );
  const [index, setIndex] = useState(0);
  useEffect(() => setIndex(0), [chain.join("~")]);

  const src = index < chain.length ? chain[index] : null;
  if (!src) {
    return (
      <div
        className={`company-logo-avatar ${className}`}
        style={{ width: size, height: size, backgroundColor: avatarColor(job.company) }}
        aria-label={`${job.company} logo`}
      >
        {avatarLetter(job.company)}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={`${job.company} logo`}
      className={`company-logo-cascade ${className}`}
      style={{ width: size, height: size }}
      loading="lazy"
      onError={() => setIndex((i) => i + 1)}
      onLoad={(e) => {
        const img = e.currentTarget;
        const isFavicon = src.includes("google.com/s2");
        if (isFavicon && img.naturalWidth > 0 && img.naturalWidth < MIN_NATURAL_WIDTH) {
          setIndex((i) => i + 1);
        }
      }}
    />
  );
}
