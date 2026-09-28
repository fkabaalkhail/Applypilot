import { useMemo, useState } from "react";
import {
  avatarColor,
  avatarLetter,
  cleanCompanyName,
  isUsableLogoImage,
  logoProviderChain,
  type JobLike,
} from "../lib/companyLogo";

interface Props extends JobLike {
  size?: number;
  className?: string;
}

export default function CompanyLogo({ size = 40, className = "", ...job }: Props) {
  const chain = useMemo(
    () => logoProviderChain(job),
    [job.company, job.company_logo, job.company_domain, job.company_url],
  );
  // Position in the chain, keyed to the chain it indexes so a new company
  // starts from its first source without a render showing the old image.
  const chainKey = chain.map((s) => s.src).join("~");
  const [cursor, setCursor] = useState({ key: chainKey, index: 0 });
  const index = cursor.key === chainKey ? cursor.index : 0;
  // Absolute, not incremental: a second event for the same source is a no-op.
  const advance = () => setCursor({ key: chainKey, index: index + 1 });

  const name = cleanCompanyName(job.company);
  const source = index < chain.length ? chain[index] : null;
  if (!source) {
    return (
      <div
        className={`company-logo-avatar ${className}`}
        style={{ width: size, height: size, backgroundColor: avatarColor(job.company) }}
        aria-label={`${name || "Company"} logo`}
      >
        {avatarLetter(job.company)}
      </div>
    );
  }
  return (
    <img
      src={source.src}
      alt={`${name || "Company"} logo`}
      className={`company-logo-cascade ${className}`}
      style={{ width: size, height: size }}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={advance}
      onLoad={(e) => {
        // Self-hosted logos were squared server-side; anything else can be a
        // 16px favicon or a social banner, which render as a blur or a strip.
        const img = e.currentTarget;
        if (!source.verified && !isUsableLogoImage(img.naturalWidth, img.naturalHeight)) {
          advance();
        }
      }}
    />
  );
}
